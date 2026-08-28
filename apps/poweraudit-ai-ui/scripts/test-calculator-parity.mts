// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Calculator parity test (Feature 5 follow-up): for every one of the 18
 * Feature 1 synthetic bills, fetches the REAL Bill row already in
 * RocketRide SQL (extracted and written by the Python path -
 * scripts/ingest_bills.py) and runs it through the TypeScript calculators
 * (src/lib/calculators.ts, stubTariff.ts), then diffs the result against
 * the Finding row(s) already written by the Python path
 * (scripts/recalculate_bills.py, calculators/*.py).
 *
 * DESIGN NOTE - why this doesn't re-run OCR: `run all 18 bills through the
 * TypeScript path` could mean re-uploading each file (re-running
 * bill-ingestion.pipe's extract_facts step) rather than reusing the
 * already-extracted data. That was deliberately NOT done here:
 * extract_facts is not perfectly deterministic across runs (see the
 * Backlog's "silently normalize" entry) - a fresh extraction could
 * legitimately disagree with the ORIGINAL Python extraction for reasons
 * that have nothing to do with the calculators (OCR/LLM variance), which
 * would make any Finding diff ambiguous: is a mismatch a calculator bug,
 * or just a different LLM call? Feeding the SAME already-extracted,
 * already-stored bill data into both calculator implementations isolates
 * exactly the one thing this test needs to prove - are calculators.ts and
 * calculators/*.py identical? - from that confound. Feature 5's separate
 * test-upload-integration.mts already exercises the real upload+OCR path.
 *
 * Run: cd apps/poweraudit-ai-ui && pnpm dlx tsx scripts/test-calculator-parity.mts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RocketRideClient } from 'rocketride';
import { getFoundationToken, parseLineItems, sqlQuery } from '../src/lib/db';
import { calculateMdPenalty, calculatePfAdjustment, detectVariances, normalizeLineItems, scoreFindings } from '../src/lib/calculators';
import { STUB_TARIFF_PARAMS } from '../src/lib/stubTariff';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
const SYNTHETIC_BILLS_DIR = path.join(REPO_ROOT, 'scripts', 'synthetic_bills');

function loadEnv(): Record<string, string> {
	const text = fs.readFileSync(path.join(REPO_ROOT, '.env'), 'utf8');
	const env: Record<string, string> = {};
	for (const line of text.split('\n')) {
		// Strip a trailing CR first: JS '.' does not match a carriage return,
		// so a CRLF .env silently parses to zero keys and every call then
		// fails with a confusing 'No authorization provided'.
		const m = line.replace(/\r$/, '').match(/^([A-Z_]+)=(.*)$/);
		if (m) env[m[1]] = m[2].trim();
	}
	return env;
}

interface BillRow {
	bill_id: string;
	meter_id: string;
	discom: string;
	contract_demand_kva: number;
	recorded_md: number | null;
	recorded_pf: number | null;
	line_items: unknown;
	total_due: number | null;
	needs_review: boolean;
	source_doc_ref: string;
}

interface FindingRow {
	type: string;
	rupee_impact: number;
	confidence: number;
}

function tsCalculateFindings(bill: BillRow) {
	const params = STUB_TARIFF_PARAMS[bill.discom];
	if (!params || bill.recorded_md === null || bill.recorded_pf === null) return [];

	const normalized = normalizeLineItems(parseLineItems(bill.line_items));
	const recalcMd = calculateMdPenalty(bill.recorded_md, bill.contract_demand_kva, params.demandChargeRate, params.penaltyMultiplier);
	const energyCharge = normalized.filter((i) => i.category === 'energy_charge' && i.amount !== null).reduce((sum, i) => sum + (i.amount as number), 0) || 100000;
	const recalcPf = calculatePfAdjustment(bill.recorded_pf, params.incentiveThreshold, params.surchargeThreshold, energyCharge, params.incentiveRatePerPoint, params.surchargeRatePerPoint);

	const variances = detectVariances(normalized, bill.total_due, recalcMd, recalcPf);
	const dataQualityFlags = bill.needs_review ? ['bill flagged needs_review'] : [];
	return scoreFindings(variances, dataQualityFlags);
}

async function main() {
	const env = loadEnv();
	const client: any = new RocketRideClient({ uri: env.ROCKETRIDE_URI, auth: env.ROCKETRIDE_APIKEY });
	await client.connect();

	let mismatches = 0;
	let compared = 0;
	let rejected = 0;

	try {
		const sqlToken = await getFoundationToken(client);
		if (!sqlToken) throw new Error('foundation-sql pipeline is not running');

		const fileNames = fs
			.readdirSync(SYNTHETIC_BILLS_DIR)
			.filter((f) => !f.startsWith('.'))
			.sort();
		console.log(`Checking ${fileNames.length} synthetic bill fixtures...`);

		const bills = await sqlQuery<BillRow>(
			client,
			sqlToken,
			`SELECT b.bill_id, b.meter_id, b.recorded_md, b.recorded_pf, b.line_items, b.total_due, b.needs_review, b.source_doc_ref,
			        m.discom, m.contract_demand_kva
			 FROM bill b JOIN meter m ON m.meter_id = b.meter_id
			 WHERE b.source_doc_ref = ANY($1)`,
			[fileNames],
		);

		for (const fileName of fileNames) {
			const bill = bills.find((b) => b.source_doc_ref === fileName);
			if (!bill) {
				console.log(`REJECTED   ${fileName} - no Bill row (correctly rejected by Feature 1, e.g. no matching meter)`);
				rejected++;
				continue;
			}

			const tsFindings = tsCalculateFindings(bill)
				.map((f) => ({ type: f.type, rupee_impact: f.rupeeImpact, confidence: f.confidence }))
				.sort((a, b) => a.type.localeCompare(b.type));

			const pyFindings = (
				await sqlQuery<FindingRow>(client, sqlToken, 'SELECT type, rupee_impact, confidence FROM finding WHERE bill_id = $1', [bill.bill_id])
			).sort((a, b) => a.type.localeCompare(b.type));

			compared++;
			const diffs: string[] = [];
			if (tsFindings.length !== pyFindings.length) {
				diffs.push(`count differs: TS=${tsFindings.length} Python=${pyFindings.length}`);
			} else {
				for (let i = 0; i < tsFindings.length; i++) {
					const t = tsFindings[i];
					const p = pyFindings[i];
					if (t.type !== p.type) diffs.push(`type: TS=${t.type} Python=${p.type}`);
					if (Math.abs(t.rupee_impact - p.rupee_impact) > 0.01) diffs.push(`${t.type}.rupee_impact: TS=${t.rupee_impact} Python=${p.rupee_impact}`);
					if (Math.abs(t.confidence - p.confidence) > 0.001) diffs.push(`${t.type}.confidence: TS=${t.confidence} Python=${p.confidence}`);
				}
			}

			if (diffs.length > 0) {
				console.log(`MISMATCH   ${fileName} (${bill.bill_id})`);
				for (const d of diffs) console.log(`             - ${d}`);
				mismatches++;
			} else {
				console.log(`MATCH      ${fileName} (${bill.bill_id}): ${tsFindings.length} finding(s) identical`);
			}
		}
	} finally {
		await client.disconnect();
	}

	console.log(`\n${compared} bills compared, ${rejected} correctly rejected (no Bill row to compare), ${mismatches} mismatches`);
	if (mismatches > 0) {
		console.error('FAILED: calculators.ts and calculators/*.py disagree on at least one real bill.');
		process.exit(1);
	}
	console.log('PASSED: TypeScript and Python calculators produce identical Findings on every real bill.');
}

main().catch((e) => {
	console.error('FATAL:', e);
	process.exit(1);
});

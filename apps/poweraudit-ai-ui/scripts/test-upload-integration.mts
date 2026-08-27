// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Integration test for the interactive bill upload (Feature 5): imports
 * the REAL app source (src/lib/{billIngestion,db,calculators,stubTariff}.ts)
 * - not a reimplementation - and drives ingestBill() against the live
 * RocketRide server with real synthetic bill files, the same way
 * UploadView.tsx does. Not bundled into the app (lives outside src/); run
 * standalone with tsx, which resolves 'rocketride' from this app's own
 * node_modules (the vendored rocketride.tgz), so no separate install is
 * needed:
 *
 *   cd apps/poweraudit-ai-ui
 *   pnpm dlx tsx scripts/test-upload-integration.mts
 *
 * Requires ../../../.env (workspace root) for ROCKETRIDE_URI/APIKEY and a
 * live foundation-sql task (see scripts/rr_common.py's
 * ensure_foundation_sql_token at the workspace root - this test resolves
 * it fresh via getFoundationToken(), same as the app does).
 *
 * Exercises all three non-fatal outcomes: OK (clean_01_M001.pdf, expects
 * the well-known Rs.4,125 pf-penalty finding), NEEDS_REVIEW
 * (corrupt_negative_md.pdf), and REJECTED (corrupt_unknown_meter.pdf).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RocketRideClient } from 'rocketride';
import { ingestBill } from '../src/lib/billIngestion';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

function loadEnv(): Record<string, string> {
	const text = fs.readFileSync(path.join(REPO_ROOT, '.env'), 'utf8');
	const env: Record<string, string> = {};
	for (const line of text.split('\n')) {
		const m = line.match(/^([A-Z_]+)=(.*)$/);
		if (m) env[m[1]] = m[2].trim();
	}
	return env;
}

interface TestCase {
	file: string;
	mimetype: string;
	expectStatus: string;
}

const TEST_CASES: TestCase[] = [
	{ file: 'clean_01_M001.pdf', mimetype: 'application/pdf', expectStatus: 'OK' },
	{ file: 'corrupt_negative_md.pdf', mimetype: 'application/pdf', expectStatus: 'NEEDS_REVIEW' },
	{ file: 'corrupt_unknown_meter.pdf', mimetype: 'application/pdf', expectStatus: 'REJECTED' },
];

async function main() {
	const env = loadEnv();
	const pipeline = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'pipelines', 'bill-ingestion.pipe'), 'utf8'));

	// `as any`: this is a real 'rocketride' client instance (not 'shell's
	// re-typed one) - see billIngestion.ts's own note on the type drift
	// between the two packages (docs/CLAUDE.md Backlog).
	const client: any = new RocketRideClient({ uri: env.ROCKETRIDE_URI, auth: env.ROCKETRIDE_APIKEY });
	await client.connect();

	let failures = 0;
	try {
		for (const { file, mimetype, expectStatus } of TEST_CASES) {
			const filePath = path.join(REPO_ROOT, 'scripts', 'synthetic_bills', file);
			const buf = fs.readFileSync(filePath);
			const fileObj = new File([buf], file, { type: mimetype });

			console.log(`\n=== ${file} (expect ${expectStatus}) ===`);
			const result = await ingestBill(client, fileObj, pipeline);
			console.log(JSON.stringify(result, null, 2));

			if (result.status !== expectStatus) {
				console.error(`FAIL: expected status ${expectStatus}, got ${result.status}`);
				failures++;
			}
		}
	} finally {
		await client.disconnect();
	}

	if (failures > 0) {
		console.error(`\n${failures} test case(s) failed.`);
		process.exit(1);
	}
	console.log('\nAll test cases passed.');
}

main().catch((e) => {
	console.error('FATAL:', e);
	process.exit(1);
});

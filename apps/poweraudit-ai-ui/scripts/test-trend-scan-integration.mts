// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Feature 3 integration test: runs the REAL portfolio-wide risk scan
 * (src/lib/trendScan.ts, driving the ported src/lib/trendAnalysis.ts)
 * against the REAL meters and bills in RocketRide SQL, and confirms it
 * writes real Alert rows - the same detection scripts/scan_trend_alerts.py
 * performs, triggered the way the UI's "Scan for Risks" button triggers it.
 *
 * Deliberately passes NO composeRecommendation callback, so the scan uses
 * its deterministic fallback text instead of calling the CrewAI pipeline.
 * That keeps this test free of Gemini quota dependence (and lets it run in
 * plain Node, since the CrewAI path needs a value import from 'shell') while
 * still exercising every line of the detection and Alert-writing logic.
 *
 * Also asserts the idempotency property the UI needs: scanning twice must
 * REFRESH each meter's alert, not accumulate duplicates - trendScan uses a
 * deterministic alert_id where scan_trend_alerts.py uses uuid4().
 *
 * Run: cd apps/poweraudit-ai-ui && pnpm dlx tsx scripts/test-trend-scan-integration.mts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RocketRideClient } from 'rocketride';
import { getFoundationToken, sqlQuery } from '../src/lib/db';
import { runWhatIf, scanForRisks } from '../src/lib/trendScan';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

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

let failures = 0;
function check(condition: boolean, label: string): void {
	if (condition) console.log(`PASS  ${label}`);
	else {
		console.log(`FAIL  ${label}`);
		failures++;
	}
}

async function main() {
	const env = loadEnv();
	const client: any = new RocketRideClient({ uri: env.ROCKETRIDE_URI, auth: env.ROCKETRIDE_APIKEY });
	await client.connect();

	try {
		const token = await getFoundationToken(client);
		if (!token) throw new Error('foundation-sql pipeline is not running');

		console.log('--- Portfolio-wide scan (what the "Scan for Risks" button runs) ---');
		const summary = await scanForRisks(client);
		console.log(`Scanned ${summary.metersScanned} meters, wrote ${summary.alertsWritten} alert(s).`);
		for (const m of summary.meters) {
			if (m.alerts.length > 0) {
				for (const a of m.alerts) console.log(`  [${a.trendType}] ${a.meterId}: projected Rs.${a.projectedImpact} - ${a.detail}`);
			}
		}

		check(summary.metersScanned > 0, 'the scan actually examined meters');
		check(summary.alertsWritten > 0, 'the scan detected at least one real risk and wrote an Alert');

		// T01 is the meter whose predicted breach was confirmed against a
		// simulated actual breach bill when Feature 3 was built.
		const t01 = summary.meters.find((m) => m.meterId === 'T01');
		check(!!t01, 'T01 (the verified breach-prediction meter) was included in the scan');
		console.log(`  T01 status: cd=${t01?.cdStatus}, pf=${t01?.pfStatus}, history points=${t01?.historyPoints}`);

		const written = await sqlQuery<{ alert_id: string; meter_id: string; trend_type: string; projected_impact: number | null; recommendation: string }>(
			client,
			token,
			"SELECT alert_id, meter_id, trend_type, projected_impact, recommendation FROM alert WHERE alert_id LIKE 'alert-%-risk' ORDER BY alert_id",
		);
		check(written.length === summary.alertsWritten, `all ${summary.alertsWritten} alert(s) are readable back from RocketRide SQL`);
		check(
			written.every((a) => typeof a.recommendation === 'string' && a.recommendation.length > 0),
			'every written Alert carries a non-empty recommendation',
		);

		// --- idempotency: the UI button can be clicked repeatedly ---
		console.log('\n--- Re-running the scan (simulating a second button click) ---');
		const before = (await sqlQuery<{ n: number }>(client, token, 'SELECT count(*) AS n FROM alert'))[0].n;
		await scanForRisks(client);
		const after = (await sqlQuery<{ n: number }>(client, token, 'SELECT count(*) AS n FROM alert'))[0].n;
		check(Number(after) === Number(before), `re-scanning refreshed alerts instead of duplicating them (${before} -> ${after})`);

		// --- what-if: must write nothing ---
		console.log('\n--- What-if projection (must write NO Alert row) ---');
		const alertsBeforeWhatIf = (await sqlQuery<{ n: number }>(client, token, 'SELECT count(*) AS n FROM alert'))[0].n;
		const whatIf = await runWhatIf(client, 'T01', 560);
		console.log(`  T01 current CD=${whatIf.currentCd}, hypothetical 560:`, whatIf.result);
		const alertsAfterWhatIf = (await sqlQuery<{ n: number }>(client, token, 'SELECT count(*) AS n FROM alert'))[0].n;

		check(whatIf.result.status === 'ok', 'what-if produced a projection for T01');
		check(Number(alertsAfterWhatIf) === Number(alertsBeforeWhatIf), 'what-if wrote NO Alert row (matches what_if_scenario.py)');
		check(
			(whatIf.result.projected_savings ?? -1) >= 0,
			`what-if reports a non-negative saving from raising CD (Rs.${whatIf.result.projected_savings})`,
		);
	} finally {
		await client.disconnect();
	}

	console.log(`\n${failures === 0 ? 'PASSED' : 'FAILED'}: ${failures} failing check(s)`);
	if (failures > 0) process.exit(1);
}

main().catch((e) => {
	console.error('FATAL:', e);
	process.exit(1);
});

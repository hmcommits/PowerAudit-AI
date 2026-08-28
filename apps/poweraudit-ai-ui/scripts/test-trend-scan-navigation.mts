// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Feature 3 hardening test. Covers the four things a risk scan has to get
 * right, against REAL meter data on the REAL server:
 *
 *   A. LIVE PARITY - the TypeScript port (src/lib/trendAnalysis.ts) produces
 *      the same classification as calculators/trend_classifier.py on the
 *      actual T01/T02/T03 histories, not just on synthetic fixtures.
 *   B. NEGATIVE CONTROL - scanning T02 (a flat, stable meter) writes nothing.
 *   C. WHAT-IF EXACTNESS - the projection matches what_if_scenario.py's
 *      output digit for digit, and writes no Alert row.
 *   D. NAVIGATION SURVIVAL - the same repro that caught the upload bug:
 *      start a scan, drop every subscriber WHILE IT IS RUNNING (which is
 *      exactly what unmounting PortfolioView does), let it finish with
 *      nothing mounted, re-subscribe, and confirm the summary survived.
 *
 * ON T01: docs and earlier sessions verified T01 as the cd-breach-risk case
 * (slope 20.0 kVA/month, months_to_breach 1.5). That hand-calculated case
 * still passes - it lives in scripts/test-trend-parity.mts, which runs the
 * exact series against the port. But T01's LIVE data no longer classifies
 * that way: a simulated breach bill was appended when Feature 3 was built,
 * so its latest recorded MD is now ABOVE Contract Demand and it correctly
 * reports `already_breached` - a breach is Feature 2's job (a Finding), not
 * a forecast. Asserting cd-breach-risk against live T01 today would be
 * asserting something false, so this test asserts what the Python original
 * actually returns for the current data, and the hand-calculated 20.0/1.5
 * case is verified where it belongs, on its fixed series.
 *
 * Run: cd apps/poweraudit-ai-ui && pnpm dlx tsx scripts/test-trend-scan-navigation.mts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RocketRideClient } from 'rocketride';
import { getFoundationToken, sqlQuery } from '../src/lib/db';
import { calculateMdPenalty } from '../src/lib/calculators';
import { buildHistory, classifyCdTrend, classifyPfTrend, whatIfCdChange } from '../src/lib/trendAnalysis';
import { runWhatIf } from '../src/lib/trendScan';
import { STUB_TARIFF_PARAMS } from '../src/lib/stubTariff';
import { getScanState, isScanInFlight, startScan, subscribeScan, __resetScanStoreForTests } from '../src/lib/trendScanStore';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

function loadEnv(): Record<string, string> {
	const text = fs.readFileSync(path.join(REPO_ROOT, '.env'), 'utf8');
	const env: Record<string, string> = {};
	for (const line of text.split('\n')) {
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function historyFor(client: any, token: string, meterId: string) {
	const rows = await sqlQuery<{ period_start: string; recorded_md: number | null; recorded_pf: number | null }>(
		client,
		token,
		'SELECT period_start, recorded_md, recorded_pf FROM bill WHERE meter_id = $1 ORDER BY period_start',
		[meterId],
	);
	const meter = (
		await sqlQuery<{ discom: string; contract_demand_kva: number }>(client, token, 'SELECT discom, contract_demand_kva FROM meter WHERE meter_id = $1', [meterId])
	)[0];
	return { history: buildHistory(rows), meter };
}

async function main() {
	const env = loadEnv();
	const client: any = new RocketRideClient({ uri: env.ROCKETRIDE_URI, auth: env.ROCKETRIDE_APIKEY });
	await client.connect();

	try {
		const token = await getFoundationToken(client);
		if (!token) throw new Error('foundation-sql pipeline is not running');

		// ---------- A. LIVE PARITY vs the Python original ----------
		// Expected values captured by running calculators/trend_classifier.py
		// against this same live data.
		console.log('--- A. TypeScript port vs Python original, on REAL meter data ---');
		for (const [meterId, expectedCd, expectedPf] of [
			['T01', 'already_breached', 'flat_or_improving'],
			['T02', 'flat_or_declining', 'flat_or_improving'],
			['T03', 'flat_or_declining', 'pf-decline-risk'],
		] as const) {
			const { history, meter } = await historyFor(client, token, meterId);
			const params = STUB_TARIFF_PARAMS[meter.discom];
			const cd = classifyCdTrend(history, meter.contract_demand_kva);
			const pf = classifyPfTrend(history, params.surchargeThreshold);
			check(cd.status === expectedCd, `${meterId}: CD trend = ${cd.status} (Python says ${expectedCd})`);
			check(pf.status === expectedPf, `${meterId}: PF trend = ${pf.status} (Python says ${expectedPf})`);
		}

		// The hand-calculated breach case T01 was originally verified against,
		// on its fixed series - the numbers docs/CLAUDE.md cites.
		const handSeries = [400, 420, 440, 460, 480, 500].map((md, i) => ({
			period_start: `2026-0${i + 1}-01`,
			recorded_md: md,
			recorded_pf: 0.95,
		}));
		const handCase = classifyCdTrend(buildHistory(handSeries), 530);
		check(handCase.status === 'cd-breach-risk', 'hand-calculated T01 case still classifies as cd-breach-risk');
		check(handCase.slope_kva_per_month === 20.0, 'hand-calculated case: slope is exactly 20.0 kVA/month');
		check(handCase.months_to_breach === 1.5, 'hand-calculated case: months_to_breach is exactly 1.5');

		// ---------- B. NEGATIVE CONTROL: T02 writes nothing ----------
		console.log('\n--- B. Negative control: scanning flat/stable T02 ---');
		const alertsBefore = Number((await sqlQuery<{ n: number }>(client, token, 'SELECT count(*) AS n FROM alert'))[0].n);
		__resetScanStoreForTests();
		await startScan(client, { meterIds: ['T02'] });
		const t02 = getScanState().summary;
		const alertsAfterT02 = Number((await sqlQuery<{ n: number }>(client, token, 'SELECT count(*) AS n FROM alert'))[0].n);
		check(t02?.metersScanned === 1, 'scanned exactly the one requested meter');
		check(t02?.alertsWritten === 0, 'T02 correctly produced NO alert (it is stable)');
		check(alertsAfterT02 === alertsBefore, 'and wrote no Alert row to RocketRide SQL');

		// ---------- C. WHAT-IF matches what_if_scenario.py exactly ----------
		console.log('\n--- C. What-if projection vs what_if_scenario.py ---');
		const wi = await runWhatIf(client, 'T01', 560);
		const r = wi.result;
		check(r.status === 'ok', 'what-if returned a projection for T01');
		check(r.projected_md_at_horizon === 580.24, `projected_md_at_horizon = ${r.projected_md_at_horizon} (Python: 580.24)`);
		check(r.current_projected_penalty === 39562.5, `penalty at current CD = ${r.current_projected_penalty} (Python: 39562.5)`);
		check(r.hypothetical_projected_penalty === 15937.5, `penalty at 560 kVA = ${r.hypothetical_projected_penalty} (Python: 15937.5)`);
		check(r.projected_savings === 23625.0, `projected savings = ${r.projected_savings} (Python: 23625.0)`);

		const alertsAfterWhatIf = Number((await sqlQuery<{ n: number }>(client, token, 'SELECT count(*) AS n FROM alert'))[0].n);
		check(alertsAfterWhatIf === alertsAfterT02, 'what-if wrote NO Alert row (matches what_if_scenario.py)');

		// Same projection computed purely locally must agree with the one that
		// went through the SQL-backed path - proves runWhatIf adds no drift.
		const { history: t01History, meter: t01Meter } = await historyFor(client, token, 'T01');
		const local = whatIfCdChange(t01History, t01Meter.contract_demand_kva, 560, STUB_TARIFF_PARAMS[t01Meter.discom], calculateMdPenalty);
		check(local.projected_savings === r.projected_savings, 'local and SQL-backed what-if agree');

		// ---------- D. NAVIGATION SURVIVAL ----------
		console.log('\n--- D. Navigating away mid-scan (the repro that caught the upload bug) ---');
		__resetScanStoreForTests();
		let rendersWhileMounted = 0;
		let unsubscribe: (() => void) | null = subscribeScan(() => {
			rendersWhileMounted++;
		});

		// T01+T03 so the scan has real work to do and stays in flight.
		const scanPromise = startScan(client, { meterIds: ['T01', 'T03'] });
		await sleep(400);
		check(isScanInFlight(), 'scan is genuinely in flight at the moment we navigate away');
		check(getScanState().stage === 'scanning', "store reports stage='scanning'");

		unsubscribe();
		unsubscribe = null;
		const rendersAtUnmount = rendersWhileMounted;
		console.log('  Navigated away (all subscribers dropped) while the scan was still running.');

		await scanPromise;
		check(!isScanInFlight(), 'scan ran to completion with NO subscribers mounted');

		let remountRenders = 0;
		subscribeScan(() => {
			remountRenders++;
		});
		const onReturn = getScanState();
		console.log(`  On returning: stage=${onReturn.stage}, alertsWritten=${onReturn.summary?.alertsWritten}`);

		check(onReturn.stage === 'done', "returning shows stage='done', not a reset button");
		check(onReturn.summary !== null, 'the scan summary survived navigating away and back');
		check(onReturn.errorMsg === null, 'the scan completed without error');
		check(rendersAtUnmount > 0 && remountRenders === 0, 'sanity: the old subscriber really was detached');
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

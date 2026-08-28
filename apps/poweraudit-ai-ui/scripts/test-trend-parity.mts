// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Trend / what-if parity test: runs the SAME cases as
 * calculators/test_calculators.py's TestHistoryAggregator,
 * TestCDTrendClassifier, TestPFTrendClassifier and TestWhatIf classes
 * against the TypeScript port (src/lib/trendAnalysis.ts) - not new
 * TypeScript-only tests. Every assertion below has a named Python
 * counterpart, including the hand-calculated T01 breach-prediction case
 * (rising 400->500 kVA against Contract Demand 530, which is T01's real
 * CD, projecting 540 kVA at the 2-month horizon and 1.5 months to breach -
 * the case that was verified live against a simulated actual breach bill).
 *
 * Pure logic, no RocketRide connection needed - same as the Python
 * unittest suite it mirrors.
 *
 * Run: cd apps/poweraudit-ai-ui && pnpm dlx tsx scripts/test-trend-parity.mts
 */
import { calculateMdPenalty } from '../src/lib/calculators';
import { buildHistory, classifyCdTrend, classifyPfTrend, whatIfCdChange } from '../src/lib/trendAnalysis';

let failures = 0;
function check(condition: boolean, label: string): void {
	if (condition) {
		console.log(`PASS  ${label}`);
	} else {
		console.log(`FAIL  ${label}`);
		failures++;
	}
}

/** Port of test_calculators.py's `_rows` helper - one row per month from
 * (start_year, start_month), defaulting whichever series isn't given so
 * build_history doesn't drop the row. */
function rows(opts: { mdSeries?: number[]; pfSeries?: number[]; startYear?: number; startMonth?: number }) {
	const startYear = opts.startYear ?? 2026;
	const startMonth = opts.startMonth ?? 1;
	const n = opts.mdSeries ? opts.mdSeries.length : (opts.pfSeries as number[]).length;
	const mdSeries = opts.mdSeries ?? Array(n).fill(100.0);
	const pfSeries = opts.pfSeries ?? Array(n).fill(0.95);
	const out = [];
	for (let i = 0; i < n; i++) {
		let month = startMonth + i;
		const year = startYear + Math.floor((month - 1) / 12);
		month = ((month - 1) % 12) + 1;
		out.push({
			period_start: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`,
			recorded_md: mdSeries[i],
			recorded_pf: pfSeries[i],
		});
	}
	return out;
}

// ---- TestHistoryAggregator ----
{
	// test_sorted_and_month_indexed
	const h = buildHistory(rows({ mdSeries: [400, 420, 440] }));
	check(JSON.stringify(h.map((p) => p.monthIndex)) === JSON.stringify([0, 1, 2]), 'history: month_index is [0,1,2]');
	check(JSON.stringify(h.map((p) => p.recordedMd)) === JSON.stringify([400, 420, 440]), 'history: recorded_md preserved in order');

	// test_out_of_order_rows_get_sorted
	const r = rows({ mdSeries: [400, 420, 440] });
	const shuffled = [r[2], r[0], r[1]];
	const hs = buildHistory(shuffled);
	check(JSON.stringify(hs.map((p) => p.recordedMd)) === JSON.stringify([400, 420, 440]), 'history: out-of-order rows get sorted chronologically');

	// test_rows_missing_fields_are_dropped
	const r2: any[] = rows({ mdSeries: [400, 420, 440] });
	r2[1].recorded_pf = null;
	check(buildHistory(r2).length === 2, 'history: rows missing a required field are dropped');
}

// ---- TestCDTrendClassifier ----
{
	// test_insufficient_data
	check(classifyCdTrend(buildHistory(rows({ mdSeries: [400, 420] })), 530).status === 'insufficient_data', 'CD trend: fewer than 3 points -> insufficient_data');

	// test_rising_trend_triggers_breach_risk_hand_calculated  (the T01 case)
	const risk = classifyCdTrend(buildHistory(rows({ mdSeries: [400, 420, 440, 460, 480, 500] })), 530);
	check(risk.status === 'cd-breach-risk', 'CD trend [T01 case]: rising 400->500 vs CD 530 -> cd-breach-risk');
	check(risk.slope_kva_per_month === 20.0, 'CD trend [T01 case]: slope is exactly 20.0 kVA/month');
	check(risk.months_to_breach === 1.5, 'CD trend [T01 case]: months_to_breach is exactly 1.5');
	check(risk.projected_md_at_horizon === 540.0, 'CD trend [T01 case]: projected MD at horizon is exactly 540.0 kVA');

	// test_flat_trend_does_not_trigger
	const flat = classifyCdTrend(buildHistory(rows({ mdSeries: [250, 250, 250, 250, 250, 250] })), 300);
	check(flat.status === 'flat_or_declining', 'CD trend: flat series -> flat_or_declining');
	check(flat.slope_kva_per_month === 0.0, 'CD trend: flat series slope is 0.0');

	// test_already_breached
	check(classifyCdTrend(buildHistory(rows({ mdSeries: [480, 490, 510] })), 500).status === 'already_breached', 'CD trend: latest already over CD -> already_breached');

	// test_rising_but_not_enough_to_cross_horizon
	check(classifyCdTrend(buildHistory(rows({ mdSeries: [400, 420, 440, 460, 480, 500] })), 600).status === 'on_track', 'CD trend: rising but horizon does not reach CD 600 -> on_track');
}

// ---- TestPFTrendClassifier ----
{
	// test_declining_trend_triggers_decline_risk_hand_calculated
	const pf = classifyPfTrend(buildHistory(rows({ pfSeries: [0.98, 0.96, 0.94, 0.92, 0.9, 0.88] })), 0.85);
	check(pf.status === 'pf-decline-risk', 'PF trend: declining 0.98->0.88 vs threshold 0.85 -> pf-decline-risk');
	check(pf.slope_per_month === -0.02, 'PF trend: slope is exactly -0.02/month');
	check(pf.months_to_breach === 1.5, 'PF trend: months_to_breach is exactly 1.5');
	check(pf.projected_pf_at_horizon === 0.84, 'PF trend: projected PF at horizon is exactly 0.84');

	// test_flat_pf_does_not_trigger
	check(classifyPfTrend(buildHistory(rows({ pfSeries: Array(6).fill(0.95) })), 0.9).status === 'flat_or_improving', 'PF trend: flat series -> flat_or_improving');

	// test_already_breached
	check(classifyPfTrend(buildHistory(rows({ pfSeries: [0.92, 0.9, 0.87] })), 0.9).status === 'already_breached', 'PF trend: latest already at/under threshold -> already_breached');
}

// ---- TestWhatIf ----
{
	// test_cd_raise_savings_hand_calculated
	const history = buildHistory(rows({ mdSeries: [400, 420, 440, 460, 480, 500] }));
	const params = { demandChargeRate: 450, penaltyMultiplier: 1.75 };
	const w = whatIfCdChange(history, 530, 560, params, calculateMdPenalty);
	check(w.status === 'ok', 'what-if: returns ok with sufficient history');
	check(w.projected_md_at_horizon === 540.0, 'what-if: projected MD 540.0 (same projection as the CD trend case)');
	check(w.current_projected_penalty === 7875.0, 'what-if: penalty at current CD 530 is exactly Rs.7875.0');
	check(w.hypothetical_projected_penalty === 0.0, 'what-if: penalty at hypothetical CD 560 is exactly Rs.0.0');
	check(w.projected_savings === 7875.0, 'what-if: projected savings exactly Rs.7875.0');

	// test_insufficient_data
	check(whatIfCdChange(buildHistory(rows({ mdSeries: [400, 420] })), 530, 560, params, calculateMdPenalty).status === 'insufficient_data', 'what-if: fewer than 3 points -> insufficient_data');
}

console.log(`\n${failures === 0 ? 'PASSED' : 'FAILED'}: ${failures} of the ported trend/what-if case(s) disagree with calculators/*.py`);
if (failures > 0) process.exit(1);

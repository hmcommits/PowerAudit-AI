// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * TypeScript port of Feature 3's deterministic trend logic:
 * calculators/history_aggregator.py, calculators/trend_classifier.py, and
 * calculators/what_if.py. Same OLS fit, same thresholds, same constants,
 * same status strings, zero LLM calls.
 *
 * WHY A PORT, NOT A CALL: the identical constraint the Feature 2
 * calculators and the Feature 4 claim state machine already hit - no
 * RocketRide pipeline node runs arbitrary deterministic Python on demand
 * (`tool_python`'s direct-invoke path doesn't work), and the browser can't
 * execute scripts/scan_trend_alerts.py or what_if_scenario.py directly. So
 * exposing Predictive Alerts / What-If in the UI needs this logic
 * client-side. This is the FOURTH such pair - see docs/CLAUDE.md's
 * standing-risk note; keep it in sync with the Python originals by hand and
 * re-verify with scripts/test-trend-parity.mts on any change to either side.
 *
 * NOT ported: the CrewAI recommendation-wording step (Feature 3 step 3).
 * That one genuinely is a pipeline (trend-recommendation.pipe) and the
 * browser can call it directly via client.chat(), so there is nothing to
 * duplicate - see trendScan.ts.
 */

// Mirrors calculators/trend_classifier.py's module constants exactly.
export const MIN_POINTS = 3;
export const LOOKBACK_PERIODS = 6;
export const WARNING_HORIZON_MONTHS = 2;

/** Same helper the Feature 2 calculators use (calculators.ts) - kept
 * identical so rounding behaviour can't drift between the two ports. */
function round(value: number, decimals: number): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

export interface HistoryPoint {
	periodStart: string; // ISO YYYY-MM-DD
	monthIndex: number;
	recordedMd: number;
	recordedPf: number;
}

export interface BillHistoryRow {
	period_start?: string | null;
	recorded_md?: number | string | null;
	recorded_pf?: number | string | null;
}

function parseIsoDate(value: string): { year: number; month: number } {
	// period_start comes back from RocketRide SQL as a DATE column, which
	// can serialize as "YYYY-MM-DD" or a full ISO timestamp - take the
	// leading date part either way.
	const [y, m] = String(value).slice(0, 10).split('-');
	return { year: Number(y), month: Number(m) };
}

/**
 * Port of history_aggregator.build_history. Drops rows missing
 * period_start / recorded_md / recorded_pf (can't place them on the trend
 * line), sorts chronologically, and indexes by CALENDAR months elapsed
 * since the earliest bill - so a skipped billing cycle doesn't silently
 * compress the time axis.
 */
export function buildHistory(rows: BillHistoryRow[]): HistoryPoint[] {
	const usable = rows
		.filter((r) => r.period_start !== null && r.period_start !== undefined && r.recorded_md !== null && r.recorded_md !== undefined && r.recorded_pf !== null && r.recorded_pf !== undefined)
		.map((r) => ({
			periodStart: String(r.period_start).slice(0, 10),
			recordedMd: Number(r.recorded_md),
			recordedPf: Number(r.recorded_pf),
			monthIndex: 0,
		}));

	usable.sort((a, b) => (a.periodStart < b.periodStart ? -1 : a.periodStart > b.periodStart ? 1 : 0));
	if (usable.length === 0) return [];

	const first = parseIsoDate(usable[0].periodStart);
	for (const entry of usable) {
		const d = parseIsoDate(entry.periodStart);
		entry.monthIndex = (d.year - first.year) * 12 + (d.month - first.month);
	}
	return usable;
}

/** Ordinary least squares. Returns null when every x is identical (the
 * denominator would be zero), matching the Python. */
function linearRegression(xs: number[], ys: number[]): { slope: number; intercept: number } | null {
	const n = xs.length;
	const xMean = xs.reduce((a, b) => a + b, 0) / n;
	const yMean = ys.reduce((a, b) => a + b, 0) / n;
	const denominator = xs.reduce((acc, x) => acc + (x - xMean) ** 2, 0);
	if (denominator === 0) return null;
	const numerator = xs.reduce((acc, x, i) => acc + (x - xMean) * (ys[i] - yMean), 0);
	const slope = numerator / denominator;
	return { slope, intercept: yMean - slope * xMean };
}

export interface CdTrendResult {
	status: 'insufficient_data' | 'already_breached' | 'flat_or_declining' | 'cd-breach-risk' | 'on_track';
	slope_kva_per_month?: number;
	latest_recorded_md?: number;
	contract_demand_kva?: number;
	months_to_breach?: number;
	projected_md_at_horizon?: number;
	warning_horizon_months?: number;
}

/** Port of trend_classifier.classify_cd_trend - see that module's docstring
 * for the full method (steps 1-6). */
export function classifyCdTrend(
	history: HistoryPoint[],
	contractDemandKva: number,
	warningHorizonMonths: number = WARNING_HORIZON_MONTHS,
	minPoints: number = MIN_POINTS,
	lookback: number = LOOKBACK_PERIODS,
): CdTrendResult {
	const points = history.slice(-lookback);
	if (points.length < minPoints) return { status: 'insufficient_data' };

	const xs = points.map((p) => p.monthIndex);
	const ys = points.map((p) => p.recordedMd);
	const fit = linearRegression(xs, ys);
	if (fit === null) return { status: 'insufficient_data' };
	const { slope, intercept } = fit;

	const latestX = xs[xs.length - 1];
	const latestY = ys[ys.length - 1];
	if (latestY >= contractDemandKva) return { status: 'already_breached', slope_kva_per_month: round(slope, 4) };
	if (slope <= 0) return { status: 'flat_or_declining', slope_kva_per_month: round(slope, 4) };

	const projected = slope * (latestX + warningHorizonMonths) + intercept;
	const monthsToBreach = (contractDemandKva - latestY) / slope;

	if (projected >= contractDemandKva) {
		return {
			status: 'cd-breach-risk',
			slope_kva_per_month: round(slope, 4),
			latest_recorded_md: latestY,
			contract_demand_kva: contractDemandKva,
			months_to_breach: round(monthsToBreach, 2),
			projected_md_at_horizon: round(projected, 2),
			warning_horizon_months: warningHorizonMonths,
		};
	}
	return { status: 'on_track', slope_kva_per_month: round(slope, 4), months_to_breach: round(monthsToBreach, 2) };
}

export interface PfTrendResult {
	status: 'insufficient_data' | 'already_breached' | 'flat_or_improving' | 'pf-decline-risk' | 'on_track';
	slope_per_month?: number;
	latest_recorded_pf?: number;
	pf_threshold?: number;
	months_to_breach?: number;
	projected_pf_at_horizon?: number;
	warning_horizon_months?: number;
}

/** Port of trend_classifier.classify_pf_trend - the mirror image of the CD
 * check: PF trending DOWN toward pf_threshold. */
export function classifyPfTrend(
	history: HistoryPoint[],
	pfThreshold: number,
	warningHorizonMonths: number = WARNING_HORIZON_MONTHS,
	minPoints: number = MIN_POINTS,
	lookback: number = LOOKBACK_PERIODS,
): PfTrendResult {
	const points = history.slice(-lookback);
	if (points.length < minPoints) return { status: 'insufficient_data' };

	const xs = points.map((p) => p.monthIndex);
	const ys = points.map((p) => p.recordedPf);
	const fit = linearRegression(xs, ys);
	if (fit === null) return { status: 'insufficient_data' };
	const { slope, intercept } = fit;

	const latestX = xs[xs.length - 1];
	const latestY = ys[ys.length - 1];
	if (latestY <= pfThreshold) return { status: 'already_breached', slope_per_month: round(slope, 4) };
	if (slope >= 0) return { status: 'flat_or_improving', slope_per_month: round(slope, 4) };

	const projected = slope * (latestX + warningHorizonMonths) + intercept;
	const monthsToBreach = (latestY - pfThreshold) / -slope;

	if (projected <= pfThreshold) {
		return {
			status: 'pf-decline-risk',
			slope_per_month: round(slope, 4),
			latest_recorded_pf: latestY,
			pf_threshold: pfThreshold,
			months_to_breach: round(monthsToBreach, 2),
			projected_pf_at_horizon: round(projected, 4),
			warning_horizon_months: warningHorizonMonths,
		};
	}
	return { status: 'on_track', slope_per_month: round(slope, 4), months_to_breach: round(monthsToBreach, 2) };
}

export interface WhatIfResult {
	status: 'ok' | 'insufficient_data';
	projected_md_at_horizon?: number;
	warning_horizon_months?: number;
	current_cd?: number;
	hypothetical_cd?: number;
	current_projected_penalty?: number;
	hypothetical_projected_penalty?: number;
	projected_savings?: number;
}

/**
 * Port of what_if.what_if_cd_change. Projects recorded_md forward exactly
 * the way classifyCdTrend does, then compares the MD penalty that
 * projection would incur under the current Contract Demand vs. a
 * hypothetical one. Writes nothing - this is the "no Alert record" path.
 *
 * Takes calculateMdPenalty as a parameter rather than importing it, so the
 * penalty formula stays single-sourced in calculators.ts (already parity-
 * verified) instead of being reimplemented here - mirroring the Python,
 * which imports calculate_md_penalty from tariff_penalty_calculator.
 */
export function whatIfCdChange(
	history: HistoryPoint[],
	currentCd: number,
	hypotheticalCd: number,
	tariffParams: { demandChargeRate: number; penaltyMultiplier: number },
	calculateMdPenalty: (recordedMd: number, cd: number, rate: number, multiplier: number) => { penalty: number },
	warningHorizonMonths: number = WARNING_HORIZON_MONTHS,
	lookback: number = LOOKBACK_PERIODS,
): WhatIfResult {
	const points = history.slice(-lookback);
	if (points.length < 3) return { status: 'insufficient_data' };

	const xs = points.map((p) => p.monthIndex);
	const ys = points.map((p) => p.recordedMd);
	const fit = linearRegression(xs, ys);
	if (fit === null) return { status: 'insufficient_data' };
	const { slope, intercept } = fit;

	// A declining trend shouldn't project a negative demand - same clamp
	// as the Python.
	const projectedMd = Math.max(slope * (xs[xs.length - 1] + warningHorizonMonths) + intercept, 0);

	const current = calculateMdPenalty(projectedMd, currentCd, tariffParams.demandChargeRate, tariffParams.penaltyMultiplier);
	const hypothetical = calculateMdPenalty(projectedMd, hypotheticalCd, tariffParams.demandChargeRate, tariffParams.penaltyMultiplier);

	return {
		status: 'ok',
		projected_md_at_horizon: round(projectedMd, 2),
		warning_horizon_months: warningHorizonMonths,
		current_cd: currentCd,
		hypothetical_cd: hypotheticalCd,
		current_projected_penalty: current.penalty,
		hypothetical_projected_penalty: hypothetical.penalty,
		projected_savings: round(current.penalty - hypothetical.penalty, 2),
	};
}

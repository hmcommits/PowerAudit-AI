// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Feature 3 orchestration for the browser: history -> trend classification
 * -> Alert rows, and the write-nothing what-if projection. Mirrors
 * scripts/scan_trend_alerts.py and scripts/what_if_scenario.py, driving the
 * ported deterministic logic in trendAnalysis.ts.
 *
 * TWO DELIBERATE DIFFERENCES from the Python scripts, both noted here so
 * they aren't mistaken for drift:
 *
 * 1. ALERT IDs ARE DETERMINISTIC. scan_trend_alerts.py mints
 *    `alert-{uuid4}` per detected risk, so re-running it accumulates a
 *    fresh duplicate Alert row for the same meter+trend every time. That is
 *    survivable for an occasional script run but not for a UI button a user
 *    can click repeatedly - it would fill the Alerts panel with duplicates
 *    within a minute. This uses `alert-{meter_id}-{trend_type}` with
 *    ON CONFLICT DO UPDATE, so re-scanning REFRESHES a meter's alert rather
 *    than duplicating it. Same lesson already recorded in docs/CLAUDE.md's
 *    Backlog for bill_id and finding_id. The Python still has the random-id
 *    behaviour; fixing it there is a separate change.
 *
 * 2. THE RECOMMENDATION COMPOSER IS INJECTED, not imported. The CrewAI
 *    wording step (Feature 3 step 3) is a real pipeline the browser can
 *    call directly (trend-recommendation.pipe via client.chat), so nothing
 *    needs porting - but taking it as a parameter keeps this module free of
 *    value imports from 'shell', so the whole scan can be exercised from a
 *    plain Node integration test. If the composer is absent or throws, the
 *    Alert is still written with a deterministic description rather than
 *    being lost - an LLM quota error should not cost you the detection.
 *
 * NOT fixed here on purpose: like the Python, the PF check uses
 * STUB_TARIFF_PARAMS' global `surchargeThreshold`, NOT the per-meter
 * `meter.pf_threshold` column. That mismatch is a real logged bug (see
 * docs/PROJECT_STATUS.md), but fixing it on only one side of a
 * dual-implementation pair is exactly what the standing-risk note forbids -
 * it must be changed in both, together.
 */

import type { RocketRideClient } from 'shell';
import { getFoundationToken, sqlQuery } from './db';
import { calculateMdPenalty, calculatePfAdjustment } from './calculators';
import { STUB_TARIFF_PARAMS } from './stubTariff';
import { buildHistory, classifyCdTrend, classifyPfTrend, whatIfCdChange, type CdTrendResult, type PfTrendResult, type WhatIfResult } from './trendAnalysis';

export interface MeterRow {
	meter_id: string;
	discom: string;
	contract_demand_kva: number;
	pf_threshold: number;
}

export type TrendType = 'cd-breach-risk' | 'pf-decline-risk';

export interface WrittenAlert {
	alertId: string;
	meterId: string;
	trendType: TrendType;
	projectedImpact: number | null;
	recommendation: string;
	/** Plain-language summary of the detection itself, independent of the
	 * LLM wording - always populated. */
	detail: string;
}

export interface MeterScanResult {
	meterId: string;
	cdStatus: CdTrendResult['status'] | 'no_tariff_params';
	pfStatus: PfTrendResult['status'] | 'no_tariff_params';
	historyPoints: number;
	alerts: WrittenAlert[];
}

export interface ScanSummary {
	meters: MeterScanResult[];
	alertsWritten: number;
	metersScanned: number;
}

async function fetchMeters(client: RocketRideClient, token: string, meterIds?: string[]): Promise<MeterRow[]> {
	if (meterIds && meterIds.length > 0) {
		return sqlQuery<MeterRow>(client, token, 'SELECT meter_id, discom, contract_demand_kva, pf_threshold FROM meter WHERE meter_id = ANY($1) ORDER BY meter_id', [meterIds]);
	}
	return sqlQuery<MeterRow>(client, token, 'SELECT meter_id, discom, contract_demand_kva, pf_threshold FROM meter ORDER BY meter_id');
}

async function fetchBillRows(client: RocketRideClient, token: string, meterId: string) {
	return sqlQuery<{ period_start: string; recorded_md: number | null; recorded_pf: number | null }>(
		client,
		token,
		'SELECT period_start, recorded_md, recorded_pf FROM bill WHERE meter_id = $1 ORDER BY period_start',
		[meterId],
	);
}

/** Ported verbatim from scan_trend_alerts.cd_trend_recommendation_prompt. */
export function cdPromptText(meterId: string, discom: string, t: CdTrendResult): string {
	return (
		`Meter ${meterId} (${discom}): recorded Maximum Demand has been rising at ${t.slope_kva_per_month} kVA/month over the recent billing history, ` +
		`latest recorded at ${t.latest_recorded_md} kVA against a Contract Demand of ${t.contract_demand_kva} kVA. Projected to reach ` +
		`${t.projected_md_at_horizon} kVA within ${t.warning_horizon_months} months, crossing the Contract Demand in an estimated ${t.months_to_breach} months.`
	);
}

/** Ported verbatim from scan_trend_alerts.pf_trend_recommendation_prompt. */
export function pfPromptText(meterId: string, discom: string, t: PfTrendResult): string {
	return (
		`Meter ${meterId} (${discom}): recorded Power Factor has been declining at ${Math.abs(t.slope_per_month ?? 0)} per month over the recent billing history, ` +
		`latest recorded at ${t.latest_recorded_pf} against a surcharge threshold of ${t.pf_threshold}. Projected to fall to ${t.projected_pf_at_horizon} ` +
		`within ${t.warning_horizon_months} months, crossing the threshold in an estimated ${t.months_to_breach} months.`
	);
}

function cdFallbackRecommendation(t: CdTrendResult): string {
	return (
		`Peak demand is climbing about ${t.slope_kva_per_month} kVA per month and is on track to pass the agreed Contract Demand of ` +
		`${t.contract_demand_kva} kVA in roughly ${t.months_to_breach} months. Consider raising Contract Demand or shifting load off the peak window before that happens.`
	);
}

function pfFallbackRecommendation(t: PfTrendResult): string {
	return (
		`Power Factor is falling about ${Math.abs(t.slope_per_month ?? 0)} per month and is on track to drop below the ${t.pf_threshold} surcharge threshold ` +
		`in roughly ${t.months_to_breach} months. Consider servicing or expanding the capacitor bank before the surcharge starts.`
	);
}

async function upsertAlert(client: RocketRideClient, token: string, alert: WrittenAlert): Promise<void> {
	await sqlQuery(
		client,
		token,
		`INSERT INTO alert (alert_id, meter_id, trend_type, projected_impact, recommendation)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (alert_id) DO UPDATE SET
		   trend_type = EXCLUDED.trend_type, projected_impact = EXCLUDED.projected_impact, recommendation = EXCLUDED.recommendation`,
		[alert.alertId, alert.meterId, alert.trendType, alert.projectedImpact, alert.recommendation],
	);
}

/**
 * Scan meters for predicted CD breaches and PF declines, writing an Alert
 * row for each risk found. Same detection logic verified against T01's
 * predicted-then-confirmed breach (see scripts/test-trend-parity.mts).
 */
export async function scanForRisks(
	client: RocketRideClient,
	opts?: { meterIds?: string[]; composeRecommendation?: (prompt: string) => Promise<string> },
): Promise<ScanSummary> {
	const token = await getFoundationToken(client);
	if (!token) throw new Error('foundation-sql pipeline is not running (no task token resolved)');

	const meters = await fetchMeters(client, token, opts?.meterIds);
	const results: MeterScanResult[] = [];
	let alertsWritten = 0;

	for (const meter of meters) {
		const params = STUB_TARIFF_PARAMS[meter.discom];
		const history = buildHistory(await fetchBillRows(client, token, meter.meter_id));

		if (!params) {
			results.push({ meterId: meter.meter_id, cdStatus: 'no_tariff_params', pfStatus: 'no_tariff_params', historyPoints: history.length, alerts: [] });
			continue;
		}

		const cdTrend = classifyCdTrend(history, meter.contract_demand_kva);
		// Same as the Python: the GLOBAL stub threshold, not meter.pf_threshold.
		const pfTrend = classifyPfTrend(history, params.surchargeThreshold);
		const alerts: WrittenAlert[] = [];

		if (cdTrend.status === 'cd-breach-risk') {
			const projected = calculateMdPenalty(cdTrend.projected_md_at_horizon as number, meter.contract_demand_kva, params.demandChargeRate, params.penaltyMultiplier);
			const detail = cdFallbackRecommendation(cdTrend);
			let recommendation = detail;
			if (opts?.composeRecommendation) {
				try {
					recommendation = await opts.composeRecommendation(cdPromptText(meter.meter_id, meter.discom, cdTrend));
				} catch {
					// Keep the deterministic text - never lose the Alert to an LLM error.
				}
			}
			const alert: WrittenAlert = {
				alertId: `alert-${meter.meter_id}-cd-breach-risk`,
				meterId: meter.meter_id,
				trendType: 'cd-breach-risk',
				projectedImpact: projected.penalty,
				recommendation,
				detail,
			};
			await upsertAlert(client, token, alert);
			alerts.push(alert);
			alertsWritten++;
		}

		if (pfTrend.status === 'pf-decline-risk') {
			// Same hardcoded 100000 energy-charge basis the Python uses for a
			// forward projection (no future bill exists to read one from).
			const projected = calculatePfAdjustment(
				pfTrend.projected_pf_at_horizon as number,
				params.incentiveThreshold,
				params.surchargeThreshold,
				100000,
				params.incentiveRatePerPoint,
				params.surchargeRatePerPoint,
			);
			const detail = pfFallbackRecommendation(pfTrend);
			let recommendation = detail;
			if (opts?.composeRecommendation) {
				try {
					recommendation = await opts.composeRecommendation(pfPromptText(meter.meter_id, meter.discom, pfTrend));
				} catch {
					/* keep deterministic text */
				}
			}
			const alert: WrittenAlert = {
				alertId: `alert-${meter.meter_id}-pf-decline-risk`,
				meterId: meter.meter_id,
				trendType: 'pf-decline-risk',
				projectedImpact: projected.amount,
				recommendation,
				detail,
			};
			await upsertAlert(client, token, alert);
			alerts.push(alert);
			alertsWritten++;
		}

		results.push({ meterId: meter.meter_id, cdStatus: cdTrend.status, pfStatus: pfTrend.status, historyPoints: history.length, alerts });
	}

	return { meters: results, alertsWritten, metersScanned: meters.length };
}

export interface WhatIfOutcome {
	meterId: string;
	discom: string;
	currentCd: number;
	result: WhatIfResult;
}

/**
 * What-if projection for one meter. Writes NOTHING - no Alert row - exactly
 * matching scripts/what_if_scenario.py's behaviour.
 */
export async function runWhatIf(client: RocketRideClient, meterId: string, hypotheticalCd: number): Promise<WhatIfOutcome> {
	const token = await getFoundationToken(client);
	if (!token) throw new Error('foundation-sql pipeline is not running (no task token resolved)');

	const meters = await fetchMeters(client, token, [meterId]);
	if (meters.length === 0) throw new Error(`No such meter: ${meterId}`);
	const meter = meters[0];

	const params = STUB_TARIFF_PARAMS[meter.discom];
	if (!params) throw new Error(`No tariff parameters on file for DISCOM '${meter.discom}'`);

	const history = buildHistory(await fetchBillRows(client, token, meterId));
	const result = whatIfCdChange(history, meter.contract_demand_kva, hypotheticalCd, params, calculateMdPenalty);

	return { meterId, discom: meter.discom, currentCd: meter.contract_demand_kva, result };
}

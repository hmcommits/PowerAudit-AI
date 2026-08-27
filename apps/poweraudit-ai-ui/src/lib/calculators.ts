// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * TypeScript port of calculators/*.py (Feature 2's deterministic
 * recalculation core - bill_line_parser, tariff_penalty_calculator,
 * variance_detector, dollar_impact_scorer). Zero LLM calls, same formulas,
 * same constants, same thresholds.
 *
 * WHY A PORT, NOT A CALL: there is no RocketRide pipeline node that runs
 * arbitrary deterministic Python on demand - tool_python's direct-invoke
 * path doesn't work (see docs/CLAUDE.md Backlog), and hosting it under an
 * agent would reintroduce non-determinism. Since the browser can't execute
 * scripts/recalculate_bills.py directly either, this file mirrors it
 * line-for-line so the same math runs whether triggered from a dev script
 * or from this app. Keep both in sync by hand if either changes.
 */

export interface NormalizedLineItem {
	description: string;
	rawAmount: unknown;
	amount: number | null;
	category: string;
}

const AMOUNT_RE = /[-+]?[\d,]+(?:\.\d+)?/;

// Ordered so more specific keywords are checked before generic ones
// (e.g. "MD Penalty" before a bare "Demand Charge" match) - matches
// calculators/bill_line_parser.py's CATEGORY_KEYWORDS exactly.
const CATEGORY_KEYWORDS: Array<[string, string[]]> = [
	['md_penalty', ['md penalty', 'maximum demand penalty', 'excess demand']],
	['pf_surcharge', ['pf surcharge', 'power factor surcharge', 'low pf']],
	['pf_incentive', ['pf incentive', 'power factor incentive', 'pf rebate']],
	['demand_charge', ['demand charge']],
	['energy_charge', ['energy charge', 'energy cost']],
	['fuel_adjustment_charge', ['fac', 'fuel adjustment']],
	['wheeling_charge', ['wheeling']],
	['electricity_duty', ['electricity duty', 'duty']],
	['tax', ['tax', 'gst', 'cess']],
];

export function parseAmount(raw: unknown): number | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw === 'number') return raw;
	let text = String(raw).trim();
	if (!text) return null;

	let negative = false;
	if (text.startsWith('(') && text.endsWith(')')) {
		negative = true;
		text = text.slice(1, -1);
	}

	const match = text.match(AMOUNT_RE);
	if (!match) return null;

	const value = Number(match[0].replace(/,/g, ''));
	if (Number.isNaN(value)) return null;
	return negative ? -value : value;
}

export function classifyLineItem(description: unknown): string {
	if (!description) return 'other';
	const text = String(description).trim().toLowerCase();
	for (const [category, keywords] of CATEGORY_KEYWORDS) {
		if (keywords.some((kw) => text.includes(kw))) return category;
	}
	return 'other';
}

/** line_items may be a dict-shaped object ({description: amount}), an
 * array of {description, amount} objects, or (from the jsonb read bug -
 * see db.ts) a Python-repr string already parsed by parseLineItems()
 * upstream into one of the first two shapes. */
export function normalizeLineItems(lineItems: unknown): NormalizedLineItem[] {
	const pairs: Array<[string, unknown]> = [];
	if (Array.isArray(lineItems)) {
		for (const entry of lineItems) {
			if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
				const obj = entry as Record<string, unknown>;
				const desc = (obj.description as string) || (obj.name as string) || '';
				pairs.push([desc, obj.amount]);
			} else if (Array.isArray(entry) && entry.length === 2) {
				pairs.push([String(entry[0]), entry[1]]);
			}
		}
	} else if (lineItems && typeof lineItems === 'object') {
		for (const [k, v] of Object.entries(lineItems as Record<string, unknown>)) pairs.push([k, v]);
	} else {
		return [];
	}

	return pairs.map(([description, rawAmount]) => ({
		description,
		rawAmount,
		amount: parseAmount(rawAmount),
		category: classifyLineItem(description),
	}));
}

export interface MdPenaltyResult {
	excessKva: number;
	penalty: number;
}

/** MD Penalty = (Recorded MD - Contract Demand) x Demand Charge Rate x
 * Penalty Multiplier - Section 2. Rates/multiplier are always caller-
 * supplied parameters, never hardcoded here (see stubTariff.ts). */
export function calculateMdPenalty(recordedMdKva: number, contractDemandKva: number, demandChargeRate: number, penaltyMultiplier: number): MdPenaltyResult {
	const excessKva = recordedMdKva - contractDemandKva;
	if (excessKva <= 0) return { excessKva: 0, penalty: 0 };
	const penalty = excessKva * demandChargeRate * penaltyMultiplier;
	return { excessKva: round(excessKva, 4), penalty: round(penalty, 2) };
}

export interface PfAdjustmentResult {
	type: 'incentive' | 'surcharge' | 'none';
	points: number;
	amount: number;
}

/** PF incentive/surcharge, mirroring tariff_penalty_calculator.calculate_pf_adjustment
 * exactly - see that module's docstring for the full formula explanation. */
export function calculatePfAdjustment(
	recordedPf: number,
	incentiveThreshold: number,
	surchargeThreshold: number,
	baseAmount: number,
	incentiveRatePerPoint: number,
	surchargeRatePerPoint: number,
): PfAdjustmentResult {
	if (recordedPf >= incentiveThreshold) {
		const points = (recordedPf - incentiveThreshold) * 100;
		const amount = points * incentiveRatePerPoint * baseAmount;
		return { type: 'incentive', points: round(points, 4), amount: round(amount, 2) };
	}
	if (recordedPf <= surchargeThreshold) {
		const points = (surchargeThreshold - recordedPf) * 100;
		const amount = points * surchargeRatePerPoint * baseAmount;
		return { type: 'surcharge', points: round(points, 4), amount: round(amount, 2) };
	}
	return { type: 'none', points: 0, amount: 0 };
}

export interface Variance {
	type: 'math-error' | 'md-penalty' | 'pf-penalty';
	billedAmount: number;
	recalculatedAmount: number;
	detail: string;
}

const TOLERANCE_RUPEES = 1.0;

function detectMathError(normalized: NormalizedLineItem[], billedTotalDue: number | null): Variance | null {
	const parsed = normalized.map((i) => i.amount).filter((a): a is number => a !== null);
	if (parsed.length === 0 || billedTotalDue === null) return null;
	const lineItemSum = round(parsed.reduce((a, b) => a + b, 0), 2);
	const diff = round(billedTotalDue - lineItemSum, 2);
	if (Math.abs(diff) <= TOLERANCE_RUPEES) return null;
	return {
		type: 'math-error',
		billedAmount: billedTotalDue,
		recalculatedAmount: lineItemSum,
		detail: `line items sum to ${lineItemSum}, bill states total_due ${billedTotalDue}`,
	};
}

function detectMdPenaltyVariance(normalized: NormalizedLineItem[], recalculatedMd: MdPenaltyResult): Variance | null {
	const billed = normalized.filter((i) => i.category === 'md_penalty' && i.amount !== null).reduce((a, i) => a + (i.amount as number), 0);
	const recalculated = recalculatedMd.penalty;
	if (Math.abs(billed - recalculated) <= TOLERANCE_RUPEES) return null;
	return {
		type: 'md-penalty',
		billedAmount: round(billed, 2),
		recalculatedAmount: recalculated,
		detail: `billed MD penalty ${round(billed, 2)} vs. recalculated ${recalculated} (excess ${recalculatedMd.excessKva} kVA)`,
	};
}

function detectPfPenaltyVariance(normalized: NormalizedLineItem[], recalculatedPf: PfAdjustmentResult): Variance | null {
	const billedSurcharge = normalized.filter((i) => i.category === 'pf_surcharge' && i.amount !== null).reduce((a, i) => a + (i.amount as number), 0);
	const billedIncentive = normalized.filter((i) => i.category === 'pf_incentive' && i.amount !== null).reduce((a, i) => a + (i.amount as number), 0);
	const billedNet = billedSurcharge - Math.abs(billedIncentive);

	let recalculatedNet = 0;
	if (recalculatedPf.type === 'surcharge') recalculatedNet = recalculatedPf.amount;
	else if (recalculatedPf.type === 'incentive') recalculatedNet = -recalculatedPf.amount;

	if (Math.abs(billedNet - recalculatedNet) <= TOLERANCE_RUPEES) return null;
	return {
		type: 'pf-penalty',
		billedAmount: round(billedNet, 2),
		recalculatedAmount: round(recalculatedNet, 2),
		detail: `billed PF adjustment (net) ${round(billedNet, 2)} vs. recalculated ${round(recalculatedNet, 2)} (${recalculatedPf.type}, ${recalculatedPf.points} points)`,
	};
}

export function detectVariances(normalized: NormalizedLineItem[], billedTotalDue: number | null, recalculatedMd: MdPenaltyResult, recalculatedPf: PfAdjustmentResult): Variance[] {
	return [detectMathError(normalized, billedTotalDue), detectMdPenaltyVariance(normalized, recalculatedMd), detectPfPenaltyVariance(normalized, recalculatedPf)].filter((v): v is Variance => v !== null);
}

export interface ScoredFinding extends Variance {
	rupeeImpact: number;
	confidence: number;
}

const CONFIDENCE_PENALTY_PER_FLAG = 0.15;
const MIN_CONFIDENCE = 0.1;

/** Sign convention: positive rupeeImpact = consumer overcharged (dispute-
 * worthy); negative = undercharged. Matches dollar_impact_scorer.py. */
export function scoreFinding(variance: Variance, dataQualityFlags: string[] = []): { rupeeImpact: number; confidence: number } {
	const rupeeImpact = round(variance.billedAmount - variance.recalculatedAmount, 2);
	let confidence = 1.0 - CONFIDENCE_PENALTY_PER_FLAG * dataQualityFlags.length;
	confidence = Math.max(MIN_CONFIDENCE, Math.min(1.0, confidence));
	return { rupeeImpact, confidence: round(confidence, 2) };
}

export function scoreFindings(variances: Variance[], dataQualityFlags: string[] = []): ScoredFinding[] {
	return variances.map((v) => ({ ...v, ...scoreFinding(v, dataQualityFlags) }));
}

function round(value: number, decimals: number): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}

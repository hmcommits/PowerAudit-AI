// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Interactive bill upload: triggers bill-ingestion.pipe via the SDK (same
 * pipeline definition scripts/rr_common.py builds - imported here as JSON,
 * never re-implemented), applies the same "Schema Validate" logic
 * scripts/ingest_bills.py uses, writes the Bill row, then recalculates it
 * immediately with the ported calculators (see calculators.ts) - the same
 * three-stage pipeline Feature 1/2's Python scripts run, triggered from the
 * UI instead of a terminal.
 */

import type { RocketRideClient } from 'shell';
import { getFoundationToken, sqlQuery, parseLineItems } from './db';
import { calculateMdPenalty, calculatePfAdjustment, detectVariances, normalizeLineItems, scoreFindings, type ScoredFinding } from './calculators';
import { STUB_CITATION, STUB_TARIFF_PARAMS } from './stubTariff';

const BILL_INGESTION_SOURCE = 'dropper_1';

interface ExtractedFields {
	meter_number?: string;
	period_start?: string;
	period_end?: string;
	recorded_md?: unknown;
	recorded_pf?: unknown;
	total_due?: unknown;
	line_items?: unknown;
	anomaly_flags?: unknown;
	[key: string]: unknown;
}

interface ValidationBlock {
	changed?: boolean;
	reason?: string;
}

export type IngestStatus = 'OK' | 'NEEDS_REVIEW' | 'REJECTED' | 'ERROR' | 'TIMEOUT';

/**
 * How long to wait for the server to return an extraction result before
 * giving up. The SDK imposes NO timeout of its own - ROCKETRIDE_typescript_API.md
 * documents `requestTimeout` as "default per-request timeout in ms
 * (default: none)" - so a sendFiles() whose response never arrives (e.g. the
 * WebSocket dropped during the ~2 minutes of OCR + LLM work) leaves an
 * un-settled promise that hangs FOREVER. That is exactly what produced the
 * reported "Uploading 100%" stuck for 30+ minutes while Server Monitor
 * showed the task completed in 1m59s.
 *
 * SIZED FROM MEASUREMENT, NOT GUESSWORK. An initial 180s felt generous
 * against the 1m59s the reported run took server-side - but a real upload
 * measured by scripts/test-upload-completion.mts took 175.9s end to end,
 * i.e. it would have been aborted with 4 seconds to spare. Free-tier Gemini
 * latency varies a lot and extract_facts' validate=true pass roughly
 * doubles the LLM calls, so the spread between a fast and a slow legitimate
 * run is wide. 300s sits far enough above the observed worst case to never
 * kill live work, while still catching a genuinely lost response in five
 * minutes instead of the 30+ minutes users actually sat through. The 90s
 * slow-warning (uploadStore.SLOW_WARNING_MS) is what keeps the user informed
 * in the meantime - the timeout is a backstop, not the feedback mechanism.
 */
export const SEND_TIMEOUT_MS = 300_000;

export class UploadTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UploadTimeoutError';
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new UploadTimeoutError(message)), ms);
		promise.then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

export interface IngestResult {
	status: IngestStatus;
	fileName: string;
	reasons: string[];
	billId?: string;
	meterId?: string;
	findings?: ScoredFinding[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toNumber(value: unknown): number | null {
	if (value === null || value === undefined || value === '') return null;
	if (typeof value === 'number') return value;
	const n = Number(String(value).replace(/,/g, '').trim());
	return Number.isNaN(n) ? null : n;
}

/** Ported from scripts/ingest_bills.py's use() + useExisting pattern - the
 * TS SDK's client.use({ ..., useExisting: true }) does the attach-or-start
 * dance in one call (see ROCKETRIDE_APPS.md's "Token management"), unlike
 * the manual liveness-check helpers the Python scripts needed.
 *
 * `pipeline` is a caller-supplied parameter, not imported here directly -
 * keeps this module decoupled from rsbuild's .pipe-as-JSON loader rule, so
 * it (and the calculators it drives) can be exercised from a plain Node
 * script for integration testing, not just inside the bundled app. */
async function ensureBillIngestionToken(client: RocketRideClient, pipeline: Record<string, unknown>): Promise<string> {
	// pipeline's declared type (Record<string, unknown> at the call site,
	// since .pipe files load as untyped JSON) doesn't structurally satisfy
	// use()'s specific PipelineConfig type (which requires a typed
	// `components` array) - widen to `any` rather than hand-model that type.
	const result = await client.use({
		pipeline: pipeline as any,
		source: BILL_INGESTION_SOURCE,
		useExisting: true,
		ttl: 1800,
		name: 'bill-ingestion-app',
	});
	return result.token;
}

/** Ported from scripts/ingest_bills.py's extract_fields(). */
function extractFields(entry: { action?: string; result?: Record<string, unknown>; error?: unknown }): {
	fields: ExtractedFields | null;
	validation: ValidationBlock;
	error: string | null;
} {
	if (entry.action !== 'complete') {
		return { fields: null, validation: {}, error: entry.error ? String(entry.error) : 'unknown pipeline error' };
	}
	const result = entry.result ?? {};
	if (result.error) {
		return { fields: null, validation: {}, error: typeof result.error === 'string' ? result.error : JSON.stringify(result.error) };
	}
	const answers = result.answers as unknown[][] | undefined;
	let raw: Record<string, unknown> | null = null;
	try {
		raw = (answers?.[0]?.[0] as Record<string, unknown>) ?? null;
	} catch {
		raw = null;
	}
	if (!raw) return { fields: {}, validation: {}, error: null };
	const fields: ExtractedFields = { ...raw };
	const validation = (fields._validation as ValidationBlock) ?? {};
	delete fields._validation;
	delete fields._provenance;
	return { fields, validation, error: null };
}

/** Ported from scripts/ingest_bills.py's validate_bill() - the "Schema
 * Validate" step, plain deterministic checks, not a pipeline node (see
 * docs/CLAUDE.md Backlog for why no such node exists). */
function validateBill(fields: ExtractedFields, validation: ValidationBlock): { needsReview: boolean; reasons: string[] } {
	const reasons: string[] = [];

	if (validation.changed) {
		reasons.push(`extractor self-corrected a value on reconciliation: ${validation.reason || 'no reason given'}`);
	}

	const anomalyText = String(fields.anomaly_flags ?? '').trim();
	if (anomalyText) reasons.push(`extractor-reported anomaly: ${anomalyText}`);

	const recordedMd = toNumber(fields.recorded_md);
	if (recordedMd === null) reasons.push('recorded_md missing or unparseable');
	else if (recordedMd < 0) reasons.push(`recorded_md is negative (${recordedMd})`);

	const recordedPf = toNumber(fields.recorded_pf);
	if (recordedPf === null) reasons.push('recorded_pf missing or unparseable');
	else if (!(recordedPf >= 0 && recordedPf <= 1.0)) reasons.push(`recorded_pf out of [0,1] range (${recordedPf})`);

	const periodStart = String(fields.period_start ?? '');
	const periodEnd = String(fields.period_end ?? '');
	if (!DATE_RE.test(periodStart)) reasons.push(`period_start missing or not ISO date (${JSON.stringify(periodStart)})`);
	if (!DATE_RE.test(periodEnd)) reasons.push(`period_end missing or not ISO date (${JSON.stringify(periodEnd)})`);
	if (DATE_RE.test(periodStart) && DATE_RE.test(periodEnd) && periodEnd < periodStart) {
		reasons.push(`billing period reversed (end ${periodEnd} before start ${periodStart})`);
	}

	const totalDue = toNumber(fields.total_due);
	if (totalDue === null) reasons.push('total_due missing or unparseable');
	else if (totalDue < 0) reasons.push(`total_due is negative (${totalDue})`);

	if (!fields.line_items) reasons.push('line_items missing or empty');

	return { needsReview: reasons.length > 0, reasons };
}

interface RecalcInput {
	billId: string;
	meterId: string;
	discom: string;
	contractDemandKva: number;
	recordedMd: number | null;
	recordedPf: number | null;
	lineItems: unknown;
	totalDue: number | null;
	needsReview: boolean;
}

/** Ported from scripts/recalculate_bills.py's per-bill loop, scoped to ONE
 * bill (not the whole table). NOTE: does NOT delete-then-reinsert findings
 * (what recalculate_bills.py does for a full-table run) - found by testing
 * against real data: bill-clean_01_M001's finding already has a Claim
 * referencing it (Feature 4's demo), so DELETE FROM finding WHERE bill_id
 * = $1 hit an FK violation from claim.finding_id. Fixed by looking up any
 * EXISTING finding for (bill_id, type) first - detectVariances() returns
 * at most one variance per type, so this is a stable natural key - and
 * UPDATEing it in place (preserving whatever finding_id it already has, so
 * any Claim's FK reference survives) rather than assuming a fixed id
 * scheme; only a genuinely new (bill_id, type) combination gets a fresh
 * deterministic finding_id. scripts/recalculate_bills.py's full-batch
 * DELETE FROM finding has the same latent bug; not fixed there yet since
 * it hasn't been re-run since claims existed - noted in docs/CLAUDE.md
 * Backlog. */
async function recalculateBill(client: RocketRideClient, sqlToken: string, bill: RecalcInput): Promise<ScoredFinding[]> {
	const params = STUB_TARIFF_PARAMS[bill.discom];
	if (!params || bill.recordedMd === null || bill.recordedPf === null) return [];

	const normalized = normalizeLineItems(bill.lineItems);
	const recalcMd = calculateMdPenalty(bill.recordedMd, bill.contractDemandKva, params.demandChargeRate, params.penaltyMultiplier);
	const energyCharge = normalized.filter((i) => i.category === 'energy_charge' && i.amount !== null).reduce((sum, i) => sum + (i.amount as number), 0) || 100000;
	const recalcPf = calculatePfAdjustment(bill.recordedPf, params.incentiveThreshold, params.surchargeThreshold, energyCharge, params.incentiveRatePerPoint, params.surchargeRatePerPoint);

	const variances = detectVariances(normalized, bill.totalDue, recalcMd, recalcPf);
	const dataQualityFlags = bill.needsReview ? ['bill flagged needs_review'] : [];
	const findings = scoreFindings(variances, dataQualityFlags);

	for (const finding of findings) {
		const existing = await sqlQuery<{ finding_id: string }>(client, sqlToken, 'SELECT finding_id FROM finding WHERE bill_id = $1 AND type = $2', [bill.billId, finding.type]);
		if (existing.length > 0) {
			await sqlQuery(client, sqlToken, 'UPDATE finding SET rupee_impact = $1, confidence = $2, tariff_citation = $3 WHERE finding_id = $4', [
				finding.rupeeImpact,
				finding.confidence,
				STUB_CITATION,
				existing[0].finding_id,
			]);
		} else {
			const findingId = `finding-${bill.billId}-${finding.type}`;
			await sqlQuery(
				client,
				sqlToken,
				'INSERT INTO finding (finding_id, bill_id, meter_id, type, rupee_impact, confidence, tariff_citation) VALUES ($1, $2, $3, $4, $5, $6, $7)',
				[findingId, bill.billId, bill.meterId, finding.type, finding.rupeeImpact, finding.confidence, STUB_CITATION],
			);
		}
	}
	return findings;
}

function sanitizeBillId(fileName: string): string {
	const base = fileName.replace(/\.[^.]+$/, '');
	return `bill-${base.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/**
 * The full interactive flow: upload -> bill-ingestion.pipe -> Schema
 * Validate -> write Bill -> recalculate -> write Findings. Mirrors
 * scripts/ingest_bills.py + scripts/recalculate_bills.py exactly, for one
 * file, triggered from the UI. `pipeline` is bill-ingestion.pipe's parsed
 * JSON - the caller imports it (see UploadView.tsx) so this module stays
 * bundler-agnostic (see ensureBillIngestionToken's docstring).
 */
export async function ingestBill(
	client: RocketRideClient,
	file: File,
	pipeline: Record<string, unknown>,
	opts?: { sendTimeoutMs?: number },
): Promise<IngestResult> {
	const sqlToken = await getFoundationToken(client);
	if (!sqlToken) {
		return { status: 'ERROR', fileName: file.name, reasons: ['foundation-sql pipeline is not running (no task token resolved)'] };
	}

	// Computed up-front (not after the meter lookup as before) so the
	// timeout path below can definitively check whether this bill exists.
	const billId = sanitizeBillId(file.name);
	const billToken = await ensureBillIngestionToken(client, pipeline);

	let results: unknown[];
	try {
		results = await withTimeout(
			client.sendFiles([{ file }], billToken),
			opts?.sendTimeoutMs ?? SEND_TIMEOUT_MS,
			'no response from the server within the timeout',
		);
	} catch (e) {
		if (!(e instanceof UploadTimeoutError)) throw e;
		// The SQL writes below are performed BY THIS CLIENT after extraction
		// returns - so a lost response means they were never attempted, not
		// that they failed. Check the database directly rather than guessing,
		// so the user is told definitively whether anything was saved.
		const existing = await sqlQuery<{ bill_id: string }>(client, sqlToken, 'SELECT bill_id FROM bill WHERE bill_id = $1', [billId]);
		const landed = existing.length > 0;
		return {
			status: 'TIMEOUT',
			fileName: file.name,
			billId: landed ? billId : undefined,
			reasons: landed
				? [
						'The server did not respond in time, but a bill with this filename IS on record - it may be from an earlier upload of the same file. Check Site Drill-down to confirm the figures are the ones you expected.',
					]
				: [
						'The server did not respond in time, and nothing was saved for this file.',
						'The extraction may still have completed server-side, but its result never reached this browser - so the bill could not be written. Re-uploading is safe: bills are keyed by filename, so a retry updates rather than duplicates.',
					],
		};
	}

	const entry = results[0] as { action?: string; result?: Record<string, unknown>; error?: unknown };

	const { fields, validation, error } = extractFields(entry);
	if (error !== null) {
		return { status: 'ERROR', fileName: file.name, reasons: [`pipeline error: ${error}`] };
	}

	const meterNumber = String(fields?.meter_number ?? '').trim();
	let meterRow: { meter_id: string; discom: string; contract_demand_kva: number } | null = null;
	if (meterNumber) {
		const rows = await sqlQuery<{ meter_id: string; discom: string; contract_demand_kva: number }>(
			client,
			sqlToken,
			'SELECT meter_id, discom, contract_demand_kva FROM meter WHERE meter_id = $1',
			[meterNumber],
		);
		meterRow = rows[0] ?? null;
	}

	const { needsReview, reasons } = validateBill(fields ?? {}, validation);

	if (!meterNumber) {
		return { status: 'REJECTED', fileName: file.name, reasons: ['meter_number missing or unreadable', ...reasons] };
	}
	if (!meterRow) {
		return { status: 'REJECTED', fileName: file.name, reasons: [`unknown meter_number '${meterNumber}' (no matching Meter record)`, ...reasons] };
	}

	const recordedMd = toNumber(fields!.recorded_md);
	const recordedPf = toNumber(fields!.recorded_pf);
	const totalDue = toNumber(fields!.total_due);
	const lineItemsForStorage = parseLineItems(fields!.line_items);

	await sqlQuery(
		client,
		sqlToken,
		`INSERT INTO bill (bill_id, meter_id, period_start, period_end, recorded_md, recorded_pf, line_items, total_due, source_doc_ref, needs_review)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		 ON CONFLICT (bill_id) DO UPDATE SET
		   meter_id = EXCLUDED.meter_id, period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end,
		   recorded_md = EXCLUDED.recorded_md, recorded_pf = EXCLUDED.recorded_pf, line_items = EXCLUDED.line_items,
		   total_due = EXCLUDED.total_due, needs_review = EXCLUDED.needs_review`,
		[billId, meterRow.meter_id, fields!.period_start ?? null, fields!.period_end ?? null, recordedMd, recordedPf, JSON.stringify(lineItemsForStorage), totalDue, file.name, needsReview],
	);

	const findings = await recalculateBill(client, sqlToken, {
		billId,
		meterId: meterRow.meter_id,
		discom: meterRow.discom,
		contractDemandKva: meterRow.contract_demand_kva,
		recordedMd,
		recordedPf,
		lineItems: lineItemsForStorage,
		totalDue,
		needsReview,
	});

	return { status: needsReview ? 'NEEDS_REVIEW' : 'OK', fileName: file.name, reasons, billId, meterId: meterRow.meter_id, findings };
}

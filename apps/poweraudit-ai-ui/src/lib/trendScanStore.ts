// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * App-level store for the portfolio-wide risk scan, mirroring uploadStore.ts.
 *
 * WHY THIS EXISTS: a scan walks every meter, reads each one's billing
 * history, and (when a risk is found) calls the CrewAI recommendation
 * pipeline before writing an Alert - so it is a long-running, multi-request
 * operation, exactly the shape that bit us twice tonight. Its state was
 * originally held in PortfolioView's local useState, which means:
 *   - navigating to another view mid-scan UNMOUNTS the component and throws
 *     the in-flight scan's state away (the upload bug, in a new feature), and
 *   - a dropped or 503'd connection would leave the button stuck on
 *     "Scanning…" forever, because the awaited promise never settles (the
 *     "Uploading 100%" bug, in a new feature).
 * Both are fixed here the same way they were for uploads: state lives at
 * module level so it outlives any component, and every request is bounded by
 * a timeout so a lost response becomes a clear message rather than a hang.
 *
 * Deliberately free of value imports from 'shell' (type-only, which erases
 * at compile time) so the whole thing is exercisable from a plain Node
 * integration test - see scripts/test-trend-scan-navigation.mts.
 */

import { useSyncExternalStore } from 'react';
import type { RocketRideClient } from 'shell';
import { scanForRisks, type ScanSummary } from './trendScan';

/** Bump when scan behaviour changes; logged once at load so a console
 * capture proves which build is live (same reasoning as uploadStore). */
export const TREND_SCAN_BUILD = 'trend-scan-store/2026-08-28';

/**
 * A scan is many sequential round trips (meters, then bills per meter, then
 * a CrewAI call per detected risk), so it is legitimately slower than a
 * single upload. 300s matches billIngestion's SEND_TIMEOUT_MS - chosen the
 * same way, well above observed real runs, purely as a backstop against a
 * lost response rather than as a limit on honest work.
 */
export const SCAN_TIMEOUT_MS = 300_000;
/** Announce slowness long before the backstop, so the button is never a
 * silent spinner. */
export const SCAN_SLOW_WARNING_MS = 45_000;

export class ScanTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ScanTimeoutError';
	}
}

export type ScanStage = 'idle' | 'scanning' | 'done';

export interface TrendScanState {
	stage: ScanStage;
	summary: ScanSummary | null;
	errorMsg: string | null;
	/** True once the scan has been running longer than SCAN_SLOW_WARNING_MS. */
	slow: boolean;
}

const INITIAL: TrendScanState = { stage: 'idle', summary: null, errorMsg: null, slow: false };

let state: TrendScanState = INITIAL;
let inFlight = false;
const listeners = new Set<() => void>();

console.log(`[poweraudit] ${TREND_SCAN_BUILD} loaded`);

function setState(patch: Partial<TrendScanState>): void {
	state = { ...state, ...patch };
	for (const listener of listeners) listener();
}

export function getScanState(): TrendScanState {
	return state;
}

export function subscribeScan(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** True while a scan is running - survives any component unmounting. */
export function isScanInFlight(): boolean {
	return inFlight;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new ScanTimeoutError('no response from the server within the timeout')), ms);
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

/**
 * Run a portfolio-wide risk scan to completion, independent of component
 * lifecycle. Not cancelled on unmount: any Alert rows the scan has already
 * written are committed server-side, so abandoning the promise would only
 * lose the SUMMARY - which is exactly the bug this store prevents.
 *
 * `composeRecommendation` is passed through to trendScan (the CrewAI
 * wording step); if it is absent or throws, trendScan falls back to
 * deterministic text so an LLM/quota error never costs you the detection.
 */
export async function startScan(
	client: RocketRideClient,
	opts?: { meterIds?: string[]; composeRecommendation?: (prompt: string) => Promise<string>; timeoutMs?: number },
): Promise<void> {
	if (inFlight) return;
	inFlight = true;
	setState({ stage: 'scanning', summary: null, errorMsg: null, slow: false });

	const slowTimer = setTimeout(() => {
		if (inFlight) setState({ slow: true });
	}, SCAN_SLOW_WARNING_MS);

	try {
		const summary = await withTimeout(
			scanForRisks(client, { meterIds: opts?.meterIds, composeRecommendation: opts?.composeRecommendation }),
			opts?.timeoutMs ?? SCAN_TIMEOUT_MS,
		);
		setState({ summary, errorMsg: null, stage: 'done', slow: false });
	} catch (e) {
		// A timeout and a dropped/503'd connection are reported the same
		// honest way: say what is and isn't known, and that re-scanning is
		// safe (alert ids are deterministic, so a retry refreshes rather
		// than duplicating).
		const isTimeout = e instanceof ScanTimeoutError;
		const detail = e instanceof Error ? e.message : String(e);
		setState({
			summary: null,
			errorMsg: isTimeout
				? 'The server did not respond in time. Any risks already found were saved, but the summary was lost - open Site Drill-down to see them. Re-scanning is safe.'
				: `The scan could not finish (${detail}). Any risks already found were saved. Re-scanning is safe.`,
			stage: 'done',
			slow: false,
		});
	} finally {
		clearTimeout(slowTimer);
		inFlight = false;
	}
}

/** Clear a finished scan result. Refuses to wipe a running scan. */
export function resetScan(): void {
	if (inFlight) return;
	setState(INITIAL);
}

/** Test-only: drop all state and subscribers between cases. */
export function __resetScanStoreForTests(): void {
	inFlight = false;
	state = INITIAL;
	listeners.clear();
}

/** React binding - any mounted component gets the live scan state, whether
 * or not it was mounted when the scan started. */
export function useScanState(): TrendScanState {
	return useSyncExternalStore(subscribeScan, getScanState, getScanState);
}

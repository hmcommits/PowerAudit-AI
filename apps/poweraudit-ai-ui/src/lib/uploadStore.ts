// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * App-level store for the interactive bill upload.
 *
 * WHY THIS EXISTS: an upload is app-level work, not view-level. It was
 * previously held in UploadView's local React state, and App.tsx renders
 * views conditionally (`if (view === 'upload') return <UploadView />`), so
 * navigating to another tab UNMOUNTED the component and threw that state
 * away mid-flight. The user came back to a reset dropzone with no progress
 * bar and no result - their submission looked silently lost. Confirmed
 * against real data: a bill uploaded and then navigated away from never
 * appeared in RocketRide SQL.
 *
 * Note what was NOT the cause: the RocketRide connection itself is a
 * shell-owned singleton (`useShellConnection()` returns "the shared
 * RocketRideClient instance" from "the ConnectionManager singleton"), and
 * this app never calls disconnect()/terminate() anywhere. Unmounting a view
 * only unsubscribes a React state listener; it cannot close the socket. So
 * the fix is to stop scoping the UPLOAD to the view - not to change
 * connection handling, which was never view-scoped to begin with.
 *
 * Deliberately framework-light: a module-level singleton plus
 * useSyncExternalStore. No value imports from 'shell' here (only a
 * type-only import, which erases at compile time) so this module can be
 * exercised directly from a plain Node integration test - see
 * scripts/test-upload-survives-navigation.mts.
 */

import { useSyncExternalStore } from 'react';
import type { RocketRideClient } from 'shell';
import { BILL_INGESTION_SOURCE, ingestBill, UploadTimeoutError, type IngestResult } from './billIngestion';

export type UploadStage = 'idle' | 'uploading' | 'processing' | 'done';

export interface UploadState {
	stage: UploadStage;
	progressPct: number;
	result: IngestResult | null;
	errorMsg: string | null;
	/** Name of the file currently being processed - lets a remounted view
	 * say WHICH bill is in flight, not just that something is. */
	fileName: string | null;
	/** Set once an upload has been running longer than SLOW_WARNING_MS, so
	 * the UI can say "this is unusual" instead of showing an unexplained
	 * spinner. Typical server-side work is ~2 minutes; a run that passes
	 * this mark is worth flagging but is NOT yet a failure. */
	slow: boolean;
	/** Set when the server has reported this task finished (apaevt_task
	 * "end") while we are still waiting for its response - lets the UI say
	 * "the server finished, collecting the result" instead of a bare
	 * spinner, and is the signal the lost-response detector runs on. */
	serverFinished: boolean;
}

/** Warn (don't fail) after 90s - comfortably past a normal ~2 minute run's
 * halfway point, and well before billIngestion's 180s hard timeout. */
export const SLOW_WARNING_MS = 90_000;

const INITIAL: UploadState = { stage: 'idle', progressPct: 0, result: null, errorMsg: null, fileName: null, slow: false, serverFinished: false };

let state: UploadState = INITIAL;
let inFlight = false;
const listeners = new Set<() => void>();

function setState(patch: Partial<UploadState>): void {
	state = { ...state, ...patch };
	// A fresh object identity each time, so useSyncExternalStore's
	// reference equality check reliably re-renders subscribers.
	for (const listener of listeners) listener();
}

export function getUploadState(): UploadState {
	return state;
}

export function subscribeUpload(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** True while an upload is running - survives any component unmounting. */
export function isUploadInFlight(): boolean {
	return inFlight;
}

/**
 * How long to keep waiting for sendFiles' response AFTER the server has
 * told us, via an `apaevt_task` `end` event, that the task is finished.
 * Once the task has ended the answer should arrive essentially at once; if
 * it hasn't within this window it is not coming, and continuing to wait for
 * the 300s hard timeout just prolongs a spinner we already know is doomed.
 */
export const TASK_END_GRACE_MS = 20_000;

let onLostAfterTaskEnd: (() => void) | null = null;
let taskEndTimer: ReturnType<typeof setTimeout> | null = null;
/** Grace window for the CURRENT upload - overridable per call so a test can
 * force the lost-response path deterministically instead of racing a real
 * upload that might legitimately finish inside the default window. */
let currentGraceMs: number = 20_000;

/**
 * Consume an `apaevt_task` event.
 *
 * THIS IS THE WIRE THAT WAS MISSING. A captured console log showed
 * `apaevt_task {"action":"end","name":"bill-ingestion-app.dropper_1"}`
 * firing 1m53s into an upload - the task genuinely finished - followed by
 * 8+ minutes of nothing, because App.tsx's only shell-event subscriber
 * early-returned on any event that wasn't `apaevt_status_upload`. The
 * completion signal arrived at the browser and was dropped on the floor,
 * so the UI sat on "Uploading 100%" indefinitely.
 *
 * Matching on `source` rather than the display `name` because the name is
 * built as `${use().name}.${source}` and would silently stop matching if
 * anyone renamed the task; the source id is structural.
 */
export function noteTaskEvent(body: { action?: string; name?: string; source?: string }): void {
	if (!inFlight) return;
	if (body.action !== 'end') return;
	if (body.source !== BILL_INGESTION_SOURCE) return;

	setState({ serverFinished: true });
	if (taskEndTimer === null) {
		taskEndTimer = setTimeout(() => {
			if (inFlight) onLostAfterTaskEnd?.();
		}, currentGraceMs);
	}
}

/**
 * Fold an `apaevt_status_upload` shell event into upload progress. Called
 * from App.tsx (which is always mounted) rather than from UploadView, so
 * progress keeps tracking correctly even while the user is on another tab.
 */
export function noteUploadProgress(body: { action?: string; bytes_sent?: number; file_size?: number }): void {
	if (state.stage !== 'uploading') return;
	const { bytes_sent, file_size, action } = body;
	const progressPct = file_size ? Math.round(((bytes_sent ?? 0) / file_size) * 100) : state.progressPct;
	setState({ progressPct, stage: action === 'complete' ? 'processing' : 'uploading' });
}

/**
 * Run a real upload to completion, independent of component lifecycle.
 * Deliberately NOT cancelled on unmount: the server-side pipeline work is
 * already committed once the file is sent, so abandoning the promise would
 * only lose the RESULT (and the SQL writes that follow extraction), which
 * is exactly the bug this store fixes.
 *
 * Guarded against concurrent uploads - the UI only offers one at a time,
 * and a second overlapping run would interleave progress events.
 */
export async function startUpload(
	client: RocketRideClient,
	file: File,
	pipeline: Record<string, unknown>,
	opts?: { sendTimeoutMs?: number; taskEndGraceMs?: number },
): Promise<void> {
	if (inFlight) return;
	inFlight = true;
	currentGraceMs = opts?.taskEndGraceMs ?? TASK_END_GRACE_MS;
	setState({ stage: 'uploading', progressPct: 0, result: null, errorMsg: null, fileName: file.name, slow: false, serverFinished: false });

	// Watchdog: the UI must never sit on a silent spinner. This only
	// ANNOUNCES slowness; the two mechanisms below actually resolve it.
	const slowTimer = setTimeout(() => {
		if (inFlight) setState({ slow: true });
	}, SLOW_WARNING_MS);

	// Lost-response detector, driven by the real apaevt_task "end" event
	// (see noteTaskEvent). Racing this against ingestBill means a dropped
	// response is caught ~20s after the task actually finishes, instead of
	// waiting out billIngestion's 300s blind backstop.
	const lostAfterTaskEnd = new Promise<never>((_, reject) => {
		onLostAfterTaskEnd = () => reject(new UploadTimeoutError('the task finished server-side but its result never reached this browser'));
	});

	try {
		const outcome = await Promise.race([ingestBill(client, file, pipeline, opts), lostAfterTaskEnd]);
		setState({ result: outcome, errorMsg: null, stage: 'done', slow: false, serverFinished: false });
	} catch (e) {
		if (e instanceof UploadTimeoutError) {
			// Same honest reporting as billIngestion's own timeout path, but
			// reached far sooner and with certainty about WHY: we saw the task
			// end, so this is definitively a lost response, not slow work.
			setState({
				result: {
					status: 'TIMEOUT',
					fileName: file.name,
					reasons: [
						'The server finished reading this bill, but its result never reached this browser, so nothing could be saved.',
						'Re-uploading is safe: bills are keyed by filename, so a retry updates rather than duplicates.',
					],
				},
				errorMsg: null,
				stage: 'done',
				slow: false,
				serverFinished: false,
			});
		} else {
			setState({ result: null, errorMsg: e instanceof Error ? e.message : String(e), stage: 'done', slow: false, serverFinished: false });
		}
	} finally {
		clearTimeout(slowTimer);
		if (taskEndTimer !== null) {
			clearTimeout(taskEndTimer);
			taskEndTimer = null;
		}
		onLostAfterTaskEnd = null;
		inFlight = false;
	}
}

/** Clear the finished result so the dropzone is offered again. Refuses to
 * wipe an upload that is still running. */
export function resetUpload(): void {
	if (inFlight) return;
	setState(INITIAL);
}

/** Test-only: drop all state and subscribers between cases. */
export function __resetUploadStoreForTests(): void {
	inFlight = false;
	state = INITIAL;
	listeners.clear();
	if (taskEndTimer !== null) {
		clearTimeout(taskEndTimer);
		taskEndTimer = null;
	}
	onLostAfterTaskEnd = null;
}

/** React binding. Any mounted component gets the live upload state,
 * whether or not it was mounted when the upload started. */
export function useUploadState(): UploadState {
	return useSyncExternalStore(subscribeUpload, getUploadState, getUploadState);
}

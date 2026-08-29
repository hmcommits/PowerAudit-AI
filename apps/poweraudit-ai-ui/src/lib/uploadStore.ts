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
import { withRetries } from './retry';

/**
 * Bump this whenever upload-completion behaviour changes. It is logged once
 * at module load so a console capture proves WHICH build the preview is
 * actually running - the dev overlay can serve a stale bundle, and without a
 * marker there is no way to tell "the fix ran and correctly did nothing"
 * apart from "the fix isn't there".
 */
export const UPLOAD_STORE_BUILD = 'upload-store/2026-08-28+task-end-wire';

/** Survives a page reload (unlike module state) so a preview refresh
 * mid-upload can be reported instead of silently resetting the dropzone. */
const INTERRUPTED_KEY = 'poweraudit.uploadInFlight';

function readInterrupted(): string | null {
	try {
		return sessionStorage.getItem(INTERRUPTED_KEY);
	} catch {
		return null;
	}
}

function writeInterrupted(fileName: string | null): void {
	try {
		if (fileName === null) sessionStorage.removeItem(INTERRUPTED_KEY);
		else sessionStorage.setItem(INTERRUPTED_KEY, fileName);
	} catch {
		/* private mode / storage disabled - degrade silently */
	}
}

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
	/** 1-based number of the attempt currently running. Stays 1 through a
	 * normal upload; only visible to the UI once a retry actually starts. */
	attempt: number;
	/** Total attempts this run will make before giving up. */
	maxAttempts: number;
}

/** Warn (don't fail) after 90s - comfortably past a normal ~2 minute run's
 * halfway point, and well before billIngestion's 180s hard timeout. */
export const SLOW_WARNING_MS = 90_000;

const INITIAL: UploadState = { stage: 'idle', progressPct: 0, result: null, errorMsg: null, fileName: null, slow: false, serverFinished: false, attempt: 1, maxAttempts: 1 };

let state: UploadState = INITIAL;
let inFlight = false;
const listeners = new Set<() => void>();

// Runs once per page load. Two jobs: prove which build is live, and detect
// an upload that a page reload killed mid-flight (the dev preview reloads
// on every rebuild, and the Design tab's own manifestRefresh reloads it
// too - either wipes this module's state and silently abandons the upload).
console.log(`[poweraudit] ${UPLOAD_STORE_BUILD} loaded`);
{
	const interrupted = readInterrupted();
	if (interrupted) {
		writeInterrupted(null);
		console.log(`[poweraudit] previous page session was uploading "${interrupted}" when it reloaded - that upload was abandoned client-side`);
		state = {
			...INITIAL,
			stage: 'done',
			fileName: interrupted,
			result: {
				status: 'TIMEOUT',
				fileName: interrupted,
				reasons: [
					'This page reloaded while the bill was still being read, so the result was lost before it could be saved.',
					'In the Design tab preview this happens on every rebuild. Re-uploading is safe: bills are keyed by filename, so a retry updates rather than duplicates.',
				],
			},
		};
	}
}

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
	// Logged unconditionally, INCLUDING the no-op paths. The previous
	// version returned silently when no upload was in flight, which made it
	// impossible to tell from a console capture whether the fix was running
	// and correctly ignoring the event, or not running at all. Every branch
	// now says what it saw and what it decided.
	if (!inFlight) {
		console.log(`[poweraudit] apaevt_task ${body.action}/${body.source} IGNORED - no upload in flight in this page session`, UPLOAD_STORE_BUILD);
		return;
	}
	if (body.action !== 'end') {
		console.log(`[poweraudit] apaevt_task ${body.action}/${body.source} ignored - not an "end"`);
		return;
	}
	if (body.source !== BILL_INGESTION_SOURCE) {
		console.log(`[poweraudit] apaevt_task end/${body.source} ignored - not this app's upload pipeline (${BILL_INGESTION_SOURCE})`);
		return;
	}

	console.log(`[poweraudit] apaevt_task end MATCHED for ${body.name} - server finished; waiting ${currentGraceMs}ms for the result`);
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

/** Total attempts a single startUpload() run makes before giving up -
 * the first try plus up to this many automatic retries. Sized per the
 * investigation: the confirmed failure (a transient WebSocket handshake
 * 503, or a silently stalled connection) is a short-lived blip, not a
 * sustained outage, so a small number of tries a few seconds apart either
 * recovers quickly or confirms the problem is not transient. */
export const MAX_UPLOAD_ATTEMPTS = 3;
/** Delay between attempts. Long enough to give a transient server-side
 * hiccup room to clear (and, if this browser tab's transport is mid
 * reconnect for an unrelated reason, room for that to finish too) without
 * feeling like a second multi-minute wait. */
export const RETRY_DELAY_MS = 5_000;

/** Runs exactly one upload attempt, including its own task-end race. Split
 * out of startUpload so each RETRY gets a fresh race and a fresh grace
 * timer, rather than one race shared across every attempt. */
async function attemptUpload(client: RocketRideClient, file: File, pipeline: Record<string, unknown>, opts?: { sendTimeoutMs?: number; taskEndGraceMs?: number }): Promise<IngestResult> {
	currentGraceMs = opts?.taskEndGraceMs ?? TASK_END_GRACE_MS;
	setState({ serverFinished: false });

	const lostAfterTaskEnd = new Promise<never>((_, reject) => {
		onLostAfterTaskEnd = () => reject(new UploadTimeoutError('the task finished server-side but its result never reached this browser', 'task-end-wire'));
	});

	try {
		return await Promise.race([ingestBill(client, file, pipeline, opts), lostAfterTaskEnd]);
	} finally {
		if (taskEndTimer !== null) {
			clearTimeout(taskEndTimer);
			taskEndTimer = null;
		}
		onLostAfterTaskEnd = null;
	}
}

/**
 * Run a real upload to completion, independent of component lifecycle,
 * automatically retrying a transient failure before ever surfacing
 * anything to the user.
 *
 * WHY RETRY HERE, NOT DEEPER: the RocketRide SDK's own reconnect (`persist:
 * true`, capped linear backoff - see ROCKETRIDE_typescript_API.md) only
 * engages once its transport recognizes a disconnect, AND the browser app
 * doesn't own that client's construction to begin with - useShellConnection()
 * returns a client built by the shell's ConnectionManager, so `persist`/
 * `requestTimeout` aren't configurable from here (checked shell.d.ts: no
 * escape hatch, and sendFiles() itself takes no per-call timeout override
 * either). A connection that stalls WITHOUT the WebSocket ever firing
 * `close` - plausible for the confirmed 503-at-handshake pattern, if the
 * same instability can also leave an established connection in limbo -
 * never fires ANY reconnect logic gated on that event, the SDK's or a
 * hypothetical one of ours. Retrying the WHOLE upload attempt at the level
 * this app actually controls is therefore not a lesser workaround for a
 * better mechanism we're missing; it's the only layer address-able from
 * here at all.
 *
 * Each attempt is a genuinely fresh try: a new sendFiles() call, a new
 * task-end race. Retrying is safe regardless of what happened to the
 * previous attempt - bills are keyed by a deterministic filename-derived
 * id, so re-processing the same file updates rather than duplicates.
 *
 * Deliberately NOT cancelled on unmount: the server-side pipeline work is
 * already committed once a file is sent, so abandoning the promise would
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
	opts?: { sendTimeoutMs?: number; taskEndGraceMs?: number; maxAttempts?: number },
): Promise<void> {
	if (inFlight) return;
	inFlight = true;
	const maxAttempts = opts?.maxAttempts ?? MAX_UPLOAD_ATTEMPTS;
	writeInterrupted(file.name);
	setState({ stage: 'uploading', progressPct: 0, result: null, errorMsg: null, fileName: file.name, slow: false, serverFinished: false, attempt: 1, maxAttempts });

	// Watchdog: the UI must never sit on a silent spinner. This only
	// ANNOUNCES slowness; the mechanisms below actually resolve it.
	const slowTimer = setTimeout(() => {
		if (inFlight) setState({ slow: true });
	}, SLOW_WARNING_MS);

	try {
		const outcome = await withRetries(() => attemptUpload(client, file, pipeline, opts), {
			attempts: maxAttempts,
			delayMs: RETRY_DELAY_MS,
			onRetry: (nextAttempt, total, error) => {
				const reason = error instanceof Error ? error.message : String(error);
				console.log(`[poweraudit] upload attempt failed (${reason}) - retrying automatically, attempt ${nextAttempt} of ${total}`);
				setState({ attempt: nextAttempt, slow: false, serverFinished: false, progressPct: 0 });
			},
		});
		setState({ result: outcome, errorMsg: null, stage: 'done', slow: false, serverFinished: false });
	} catch (e) {
		if (e instanceof UploadTimeoutError) {
			// Every automatic attempt is exhausted. Keep the two DIFFERENT,
			// deliberately-worded explanations distinct rather than collapsing
			// them into one generic message: "we saw the task finish server-side"
			// is a stronger, more precise claim than "we waited a while with no
			// signal either way" - conflating them would understate what the
			// task-end wire actually proved on the last attempt.
			const attemptsPhrase = maxAttempts > 1 ? ` after ${maxAttempts} attempts` : '';
			const primaryReason =
				e.reason === 'task-end-wire'
					? `The server finished reading this bill${attemptsPhrase}, but its result never reached this browser, so nothing could be saved.`
					: `The server did not respond${attemptsPhrase}, so nothing could be saved.`;
			setState({
				result: {
					status: 'TIMEOUT',
					fileName: file.name,
					reasons: [primaryReason, 'Re-uploading is safe: bills are keyed by filename, so a retry updates rather than duplicates.'],
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
		writeInterrupted(null);
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

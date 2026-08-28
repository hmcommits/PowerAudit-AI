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
import { ingestBill, type IngestResult } from './billIngestion';

export type UploadStage = 'idle' | 'uploading' | 'processing' | 'done';

export interface UploadState {
	stage: UploadStage;
	progressPct: number;
	result: IngestResult | null;
	errorMsg: string | null;
	/** Name of the file currently being processed - lets a remounted view
	 * say WHICH bill is in flight, not just that something is. */
	fileName: string | null;
}

const INITIAL: UploadState = { stage: 'idle', progressPct: 0, result: null, errorMsg: null, fileName: null };

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
export async function startUpload(client: RocketRideClient, file: File, pipeline: Record<string, unknown>): Promise<void> {
	if (inFlight) return;
	inFlight = true;
	setState({ stage: 'uploading', progressPct: 0, result: null, errorMsg: null, fileName: file.name });
	try {
		const outcome = await ingestBill(client, file, pipeline);
		setState({ result: outcome, errorMsg: null, stage: 'done' });
	} catch (e) {
		setState({ result: null, errorMsg: e instanceof Error ? e.message : String(e), stage: 'done' });
	} finally {
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
}

/** React binding. Any mounted component gets the live upload state,
 * whether or not it was mounted when the upload started. */
export function useUploadState(): UploadState {
	return useSyncExternalStore(subscribeUpload, getUploadState, getUploadState);
}

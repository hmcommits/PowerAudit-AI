// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Generic automatic-retry primitive, extracted so the retry ORCHESTRATION
 * itself (does it call the right number of times, wait the right amount,
 * give up correctly, succeed on a later attempt) is testable in complete
 * isolation from RocketRide - no server, no tokens spent - while still being
 * the exact code the real upload path runs (see uploadStore.ts), not a
 * reimplementation.
 *
 * WHY THIS EXISTS: investigating tonight's "still not reliably working"
 * report found that the actual missing piece was never detection (that part
 * was already solid - timeout, task-end wire, reload detection) but
 * RECOVERY. The RocketRide SDK's own transport-level reconnect (`persist:
 * true`, capped linear backoff, documented in ROCKETRIDE_typescript_API.md)
 * only engages once the transport recognizes a disconnect - but the browser
 * app doesn't even own that decision: `useShellConnection()`'s client is
 * constructed by the shell's ConnectionManager, not this app, so `persist`/
 * `requestTimeout` aren't ours to set. A connection that silently stalls
 * WITHOUT the WebSocket ever firing `close` (plausible for the confirmed
 * 503-at-handshake pattern, if the same instability leaves an established
 * connection in limbo) never triggers ANY reconnect logic gated on that
 * event - ours or the SDK's. A client-side timeout is therefore not a
 * lesser stand-in for something the SDK could do better; for this specific
 * failure shape, it is the only mechanism that can ever fire at all.
 *
 * What WAS missing: after detecting the failure, nothing retried - the user
 * had to notice and manually re-drop the file. This closes that gap.
 */

export interface RetryOptions {
	/** Total attempts, including the first - not the retry count. */
	attempts: number;
	/** Delay between attempts, in ms. */
	delayMs: number;
	/** Called before each retry (not before the first attempt), with the
	 * 1-based number of the attempt about to run and the error that just
	 * failed - lets the caller surface "retrying (2 of 3)…" instead of
	 * retrying silently. */
	onRetry?: (nextAttempt: number, totalAttempts: number, error: unknown) => void;
}

/**
 * Run `fn` up to `attempts` times with a fixed delay between failures,
 * returning the first successful result. Throws the LAST error once
 * attempts are exhausted. Every error is treated as retryable - the caller
 * decides what's worth retrying by what it puts in `fn` (see
 * uploadStore.ts: only a thrown failure is retried; a normal business
 * outcome like REJECTED/NEEDS_REVIEW is a resolved value, not an error, so
 * it is never retried).
 */
export async function withRetries<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= opts.attempts; attempt++) {
		try {
			return await fn();
		} catch (e) {
			lastError = e;
			if (attempt >= opts.attempts) break;
			opts.onRetry?.(attempt + 1, opts.attempts, e);
			await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
		}
	}
	throw lastError;
}

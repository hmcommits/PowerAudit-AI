// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useShellConnection } from 'shell';
import { getFoundationToken, sqlQuery } from './db';

interface UseSqlQueryResult<T> {
	rows: T[] | null;
	error: string | null;
	loading: boolean;
	/** True while an automatic retry is in flight after a failed attempt -
	 * lets the UI show "Reconnecting…" instead of jumping straight to an
	 * error banner. The foundation-sql host task can be idle-reaped by the
	 * server at any time (see getFoundationToken() in db.ts, which already
	 * self-heals this on its own); this is a second layer of defense for
	 * any other transient failure, since that can happen mid-demo, not
	 * just during development. */
	retrying: boolean;
	/** Re-run the query against RocketRide SQL right now - this is how the
	 * dashboard reflects a change made outside the app (e.g. re-running
	 * recalculate_bills.py) without a rebuild: no cached copy survives a
	 * refetch, every call goes straight to the live database. */
	refetch: () => Promise<void>;
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs one SQL query against the foundation-sql pipeline and keeps the
 * result in React state. Re-fetches whenever `sql`/`params` change
 * (compared by JSON identity) or the connection comes up; call `refetch()`
 * for a manual refresh. On failure, retries automatically (with a short
 * delay) up to MAX_ATTEMPTS before surfacing `error` - most failures here
 * are the foundation-sql host task being transiently unavailable (starting
 * back up after an idle-reap), not a real, permanent problem.
 */
export function useSqlQuery<T = Record<string, unknown>>(sql: string, params?: unknown[]): UseSqlQueryResult<T> {
	const { client, isConnected } = useShellConnection();
	const [rows, setRows] = useState<T[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [retrying, setRetrying] = useState(false);
	const paramsKey = JSON.stringify(params ?? []);
	const paramsRef = useRef(params);
	paramsRef.current = params;

	const refetch = useCallback(async () => {
		if (!client || !isConnected) return;
		setLoading(true);
		setError(null);
		setRetrying(false);

		let lastError: unknown = null;
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			try {
				const token = await getFoundationToken(client);
				if (!token) throw new Error('foundation-sql pipeline is not running (no task token resolved)');
				const result = await sqlQuery<T>(client, token, sql, paramsRef.current);
				setRows(result);
				setError(null);
				setRetrying(false);
				setLoading(false);
				return;
			} catch (e) {
				lastError = e;
				if (attempt < MAX_ATTEMPTS) {
					setRetrying(true);
					await delay(RETRY_DELAY_MS);
				}
			}
		}
		setError(lastError instanceof Error ? lastError.message : String(lastError));
		setRetrying(false);
		setLoading(false);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [client, isConnected, sql, paramsKey]);

	useEffect(() => {
		void refetch();
	}, [refetch]);

	return { rows, error, loading, retrying, refetch };
}

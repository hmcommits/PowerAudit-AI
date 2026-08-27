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
	/** Re-run the query against RocketRide SQL right now - this is how the
	 * dashboard reflects a change made outside the app (e.g. re-running
	 * recalculate_bills.py) without a rebuild: no cached copy survives a
	 * refetch, every call goes straight to the live database. */
	refetch: () => Promise<void>;
}

/**
 * Runs one SQL query against the foundation-sql pipeline and keeps the
 * result in React state. Re-fetches whenever `sql`/`params` change
 * (compared by JSON identity) or the connection comes up; call `refetch()`
 * for a manual refresh.
 */
export function useSqlQuery<T = Record<string, unknown>>(sql: string, params?: unknown[]): UseSqlQueryResult<T> {
	const { client, isConnected } = useShellConnection();
	const [rows, setRows] = useState<T[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const paramsKey = JSON.stringify(params ?? []);
	const paramsRef = useRef(params);
	paramsRef.current = params;

	const refetch = useCallback(async () => {
		if (!client || !isConnected) return;
		setLoading(true);
		setError(null);
		try {
			const token = await getFoundationToken(client);
			if (!token) throw new Error('foundation-sql pipeline is not running (no task token resolved)');
			const result = await sqlQuery<T>(client, token, sql, paramsRef.current);
			setRows(result);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [client, isConnected, sql, paramsKey]);

	useEffect(() => {
		void refetch();
	}, [refetch]);

	return { rows, error, loading, refetch };
}

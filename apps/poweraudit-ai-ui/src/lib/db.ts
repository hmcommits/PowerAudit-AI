// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * RocketRide SQL access for the dashboard, via the shared foundation-sql
 * pipeline (see ../../../../scripts/rr_common.py's build_foundation_sql_pipeline
 * and ensure_foundation_sql_token - same project/source id, same reasoning:
 * rocketride_sql has no pipeline dataflow write lane, so both the Python
 * scripts and this app reach it the same way, via client.database.query()
 * against a "tools"-hosted task, never by embedding SQL in a .pipe node).
 */

import type { RocketRideClient } from 'rocketride';

export const FOUNDATION_PROJECT_ID = 'b3f2a6b4-9b0d-4c3a-8e77-4a2f6a1c9d10';
export const FOUNDATION_SOURCE = 'tools_1';

let cachedToken: string | null = null;

/**
 * Resolve a live task token for foundation-sql.pipe. Mirrors
 * scripts/rr_common.py's ensure_foundation_sql_token: getTaskToken can
 * resolve a project/source mapping whose underlying task has since been
 * terminated, so a cached token is verified with a cheap real call
 * (database.dialect) before being trusted, and re-resolved otherwise.
 */
export async function getFoundationToken(client: RocketRideClient): Promise<string | null> {
	if (cachedToken) {
		try {
			await client.database.dialect({ token: cachedToken });
			return cachedToken;
		} catch {
			cachedToken = null;
		}
	}
	try {
		const token = await client.getTaskToken({ projectId: FOUNDATION_PROJECT_ID, source: FOUNDATION_SOURCE });
		if (token) cachedToken = token;
		return token ?? null;
	} catch {
		return null;
	}
}

/** Thin wrapper over client.database.query() typed for our row shapes. */
export async function sqlQuery<T = Record<string, unknown>>(
	client: RocketRideClient,
	token: string,
	sql: string,
	params?: unknown[],
): Promise<T[]> {
	const result = await client.database.query({ token, sql, params });
	return (result.rows ?? []) as T[];
}

/**
 * client.database.query() returns `jsonb` column values as Python repr()
 * text (single-quoted, e.g. "{'x': 1}") instead of valid JSON - a
 * server-side read-path serialization bug confirmed on BOTH the Python and
 * TypeScript SDKs (see docs/CLAUDE.md's Backlog section). json.parse/
 * JSON.parse fails on this text outright. This is a small hand-rolled
 * parser for Python literal syntax (dict/list/str/number/True/False/None) -
 * safe here since bill.line_items is our own application data, written by
 * our own scripts, never external input.
 */
export function parsePyLiteral(text: string): unknown {
	let i = 0;

	function skipWs(): void {
		while (i < text.length && /\s/.test(text[i])) i++;
	}

	function parseValue(): unknown {
		skipWs();
		const c = text[i];
		if (c === '{') return parseDict();
		if (c === '[') return parseList();
		if (c === "'" || c === '"') return parseString();
		if (text.startsWith('None', i)) {
			i += 4;
			return null;
		}
		if (text.startsWith('True', i)) {
			i += 4;
			return true;
		}
		if (text.startsWith('False', i)) {
			i += 5;
			return false;
		}
		return parseNumber();
	}

	function parseString(): string {
		const quote = text[i];
		i++;
		let out = '';
		while (i < text.length && text[i] !== quote) {
			if (text[i] === '\\' && i + 1 < text.length) {
				out += text[i + 1];
				i += 2;
			} else {
				out += text[i];
				i++;
			}
		}
		i++; // closing quote
		return out;
	}

	function parseNumber(): number {
		const start = i;
		while (i < text.length && /[-+0-9.eE]/.test(text[i])) i++;
		return Number(text.slice(start, i));
	}

	function parseList(): unknown[] {
		i++; // [
		const out: unknown[] = [];
		skipWs();
		if (text[i] === ']') {
			i++;
			return out;
		}
		for (;;) {
			out.push(parseValue());
			skipWs();
			if (text[i] === ',') {
				i++;
				skipWs();
				continue;
			}
			break;
		}
		skipWs();
		i++; // ]
		return out;
	}

	function parseDict(): Record<string, unknown> {
		i++; // {
		const out: Record<string, unknown> = {};
		skipWs();
		if (text[i] === '}') {
			i++;
			return out;
		}
		for (;;) {
			skipWs();
			const key = String(parseValue());
			skipWs();
			i++; // :
			out[key] = parseValue();
			skipWs();
			if (text[i] === ',') {
				i++;
				skipWs();
				continue;
			}
			break;
		}
		skipWs();
		i++; // }
		return out;
	}

	return parseValue();
}

/** Parse a bill.line_items value that may already be an object/array
 * (a future-fixed server would return real JSON) or Python-repr text
 * (today's reality) - never throws; returns [] on anything unparseable. */
export function parseLineItems(raw: unknown): Array<{ description?: string; amount?: unknown }> {
	if (Array.isArray(raw)) return raw as Array<{ description?: string; amount?: unknown }>;
	if (raw && typeof raw === 'object') return Object.entries(raw as Record<string, unknown>).map(([description, amount]) => ({ description, amount }));
	if (typeof raw === 'string' && raw.trim()) {
		try {
			const parsed = parsePyLiteral(raw);
			return parseLineItems(parsed);
		} catch {
			return [];
		}
	}
	return [];
}

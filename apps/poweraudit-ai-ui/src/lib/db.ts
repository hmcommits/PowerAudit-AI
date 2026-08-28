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

// Typed against 'shell's RocketRideClient, not 'rocketride's - useShellConnection()
// returns the shell's own client instance/type, and the two packages' type
// declarations have drifted slightly (shell's is missing a couple of newer
// methods) even though they're structurally the same client at runtime.
import type { RocketRideClient } from 'shell';

export const FOUNDATION_PROJECT_ID = 'b3f2a6b4-9b0d-4c3a-8e77-4a2f6a1c9d10';
export const FOUNDATION_SOURCE = 'tools_1';

let cachedToken: string | null = null;

/** Bare node-builder, mirroring scripts/rr_common.py's `node()` helper -
 * same default `ui` block when the caller doesn't supply one. */
function node(id: string, provider: string, config: Record<string, unknown>, extra?: { control?: unknown[]; ui?: Record<string, unknown> }): Record<string, unknown> {
	const c: Record<string, unknown> = { id, provider, config };
	if (extra?.control) c.control = extra.control;
	c.ui = extra?.ui ?? { position: { x: 20, y: 200 }, measured: { width: 150, height: 66 }, nodeType: 'default', formDataValid: true };
	return c;
}

/**
 * TypeScript port of scripts/rr_common.py's build_foundation_sql_pipeline() -
 * same node graph (tools -> rocketride_sql -> llm_gemini), same ids, same
 * config, so getFoundationToken() can start this pipeline itself instead of
 * assuming it's already running. See docs/CLAUDE.md's standing-risk note:
 * this and getFoundationToken's liveness-check/auto-start logic below are
 * now a third piece of logic duplicated between Python and TypeScript and
 * must be kept in sync by hand.
 */
function buildFoundationSqlPipeline(): Record<string, unknown> {
	const tools1 = node('tools_1', 'tools', { hideForm: true, mode: 'Source', parameters: {}, type: 'tools' });
	const rocketrideSql1 = node(
		'rocketride_sql_1',
		'rocketride_sql',
		{
			profile: 'default',
			default: {
				db_description:
					'PowerAudit AI relational store: Site, Meter, TariffOrder, Bill, Finding, Alert, Claim tables for auditing Indian commercial/industrial electricity bills (MD/PF penalty recalculation, disputes, claims).',
				table: '_direct_execute',
				max_attempts: 5,
				allow_execute: true,
			},
			parameters: {},
		},
		{ control: [{ classType: 'tool', from: 'tools_1' }], ui: { position: { x: 240, y: 200 }, measured: { width: 150, height: 135 }, nodeType: 'default', formDataValid: true } },
	);
	const llmGemini1 = node(
		'llm_gemini_1',
		'llm_gemini',
		{ profile: 'models-gemini-3-5-flash-lite', 'models-gemini-3-5-flash-lite': { apikey: '${ROCKETRIDE_GEMINI_KEY}' }, parameters: {} },
		{ control: [{ classType: 'llm', from: 'rocketride_sql_1' }], ui: { position: { x: 240, y: 360 }, measured: { width: 150, height: 66 }, nodeType: 'default', formDataValid: true } },
	);
	return {
		components: [tools1, rocketrideSql1, llmGemini1],
		source: FOUNDATION_SOURCE,
		project_id: FOUNDATION_PROJECT_ID,
		viewport: { x: 0, y: 0, zoom: 1 },
		version: 1,
	};
}

/**
 * Resolve a live task token for foundation-sql.pipe, STARTING it if it
 * isn't already running - full port of scripts/rr_common.py's
 * ensure_foundation_sql_token, not just its liveness-check half. Found by
 * testing against the real server: the previous version of this function
 * re-resolved a project/source mapping via getTaskToken() on a cache miss
 * but never verified THAT token was actually alive, and never fell back to
 * starting the pipeline - so once the always-on host task got idle-reaped
 * server-side (confirmed via Server Monitor showing 0 running tasks - the
 * same reaping behavior already documented for the Python scripts), every
 * view relying on this silently broke with "no task token resolved"
 * instead of self-healing the way ingest_bills.py/recalculate_bills.py do.
 *
 * Order of attempts, exactly matching the Python version: (1) a cached
 * token, verified live via database.dialect(); (2) a fresh getTaskToken()
 * resolution, ALSO verified live (a resolved project/source mapping can
 * point at an already-dead task); (3) start the pipeline fresh via
 * client.use() and cache the new token. Only step 3 can throw - a genuine
 * connection failure should surface as a real error, not a silent null.
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
		if (token) {
			try {
				await client.database.dialect({ token });
				cachedToken = token;
				return token;
			} catch {
				// Resolved a token, but the task behind it is dead (idle-reaped) -
				// fall through to starting a fresh one, same as the Python guard.
			}
		}
	} catch {
		// getTaskToken() itself throws when no project/source mapping exists
		// yet (e.g. the very first run) - also falls through to starting fresh.
	}

	const result = await client.use({
		pipeline: buildFoundationSqlPipeline() as any,
		source: FOUNDATION_SOURCE,
		ttl: 0,
		name: 'poweraudit-foundation-sql',
	});
	cachedToken = result.token;
	return result.token;
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

// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Foundation-sql recovery test: confirms src/lib/db.ts's getFoundationToken()
 * actually self-heals when the always-on foundation-sql host task has been
 * idle-reaped by the server - the real condition observed via Server Monitor
 * (Tasks: 0 running) that broke every dashboard view with "foundation-sql
 * pipeline is not running (no task token resolved)" before this fix, and the
 * same server behavior scripts/rr_common.py's ensure_foundation_sql_token
 * already handles for the Python scripts.
 *
 * Two phases against the REAL server, importing the REAL db.ts (not a
 * reimplementation):
 *  1. Warm path - a normal query works, and calling getFoundationToken again
 *     immediately reuses the cached token (no round trip).
 *  2. Cold path - explicitly terminates the exact task behind the resolved
 *     token (simulating idle-reaping without waiting for it to happen
 *     naturally), confirms termination actually took (a direct
 *     database.dialect() call on that token now fails), then calls
 *     getFoundationToken again IN THE SAME PROCESS (so the module-level
 *     token cache is still populated, exactly like a browser tab that's
 *     been open a while) and confirms a real query now succeeds again.
 *     NOTE: the recovered token can legitimately be the SAME string as the
 *     terminated one - client.use() appears to allocate a token
 *     deterministically per project_id, not per invocation - so this does
 *     NOT assert the token changed, only that the connection actually
 *     works again after the dead-task detection + restart.
 *
 * Run: cd apps/poweraudit-ai-ui && pnpm dlx tsx scripts/test-foundation-sql-recovery.mts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RocketRideClient } from 'rocketride';
import { getFoundationToken, sqlQuery } from '../src/lib/db';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

function loadEnv(): Record<string, string> {
	const text = fs.readFileSync(path.join(REPO_ROOT, '.env'), 'utf8');
	const env: Record<string, string> = {};
	for (const line of text.split('\n')) {
		const m = line.match(/^([A-Z_]+)=(.*)$/);
		if (m) env[m[1]] = m[2].trim();
	}
	return env;
}

let failures = 0;
function check(condition: boolean, label: string): void {
	if (condition) {
		console.log(`PASS  ${label}`);
	} else {
		console.log(`FAIL  ${label}`);
		failures++;
	}
}

async function main() {
	const env = loadEnv();
	const client: any = new RocketRideClient({ uri: env.ROCKETRIDE_URI, auth: env.ROCKETRIDE_APIKEY });
	await client.connect();

	try {
		console.log('--- Phase 1: warm path (task already running, or started here) ---');
		const token1 = await getFoundationToken(client);
		check(!!token1, 'getFoundationToken resolved a token');

		const rows1 = await sqlQuery<{ one: number }>(client, token1!, 'SELECT 1 AS one');
		check(rows1[0]?.one === 1, 'a real query succeeds with the resolved token');

		const token1b = await getFoundationToken(client);
		check(token1b === token1, 'a second call reuses the cached token (no round trip needed)');

		console.log(`\n--- Phase 2: cold path - terminating the task behind ${token1} to simulate idle-reaping ---`);
		await client.terminate(token1);

		let dialectFailedAfterTerminate = false;
		try {
			await client.database.dialect({ token: token1 });
		} catch {
			dialectFailedAfterTerminate = true;
		}
		check(dialectFailedAfterTerminate, 'terminate() really killed the task - a direct dialect() call on it now fails');

		console.log('Calling getFoundationToken again in the SAME process (cache is still warm, like a live browser tab)...');
		const token2 = await getFoundationToken(client);
		check(!!token2, 'getFoundationToken recovered after its task was terminated');

		const rows2 = await sqlQuery<{ one: number }>(client, token2!, 'SELECT 1 AS one');
		check(rows2[0]?.one === 1, 'a real query succeeds with the recovered token - the connection actually works again');
	} finally {
		await client.disconnect();
	}

	console.log(`\n${failures === 0 ? 'PASSED' : 'FAILED'}: ${failures} failing check(s)`);
	if (failures > 0) process.exit(1);
}

main().catch((e) => {
	console.error('FATAL:', e);
	process.exit(1);
});

// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import React from 'react';
import { Banner, Button, Card, ContentHeader, EmptyState, MiniCard, MiniContainer } from 'shell';
import { useSqlQuery } from '../lib/useSqlQuery';

// "Open" Finding: no Claim yet, or its Claim hasn't reached a terminal
// state (credited/denied) - Section 3 gives Finding no status field of its
// own, so openness is derived from the linked Claim's lifecycle.
const OPEN_FINDINGS_SQL = `
	SELECT count(*) AS n, COALESCE(SUM(f.rupee_impact) FILTER (WHERE f.rupee_impact > 0), 0) AS total_impact
	FROM finding f
	LEFT JOIN claim c ON c.finding_id = f.finding_id
	WHERE c.claim_id IS NULL OR c.status NOT IN ('credited', 'denied')
`;
// Section 3's Alert has no status/dismissal field either - every row is
// "active" until a future feature adds one.
const ALERTS_SQL = `SELECT count(*) AS n FROM alert`;
const CLAIMS_IN_PROGRESS_SQL = `SELECT count(*) AS n FROM claim WHERE status NOT IN ('credited', 'denied')`;

interface CountRow {
	n: number;
	total_impact?: number;
}

function formatRupees(value: number | undefined): string {
	return `Rs. ${Math.round(Number(value ?? 0)).toLocaleString('en-IN')}`;
}

export const PortfolioView: React.FC = () => {
	const findings = useSqlQuery<CountRow>(OPEN_FINDINGS_SQL);
	const alerts = useSqlQuery<CountRow>(ALERTS_SQL);
	const claims = useSqlQuery<CountRow>(CLAIMS_IN_PROGRESS_SQL);

	const loading = findings.loading || alerts.loading || claims.loading;
	const error = findings.error ?? alerts.error ?? claims.error;

	const refreshAll = () => {
		void findings.refetch();
		void alerts.refetch();
		void claims.refetch();
	};

	const hasData = findings.rows && alerts.rows && claims.rows;

	return (
		<div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
			<ContentHeader
				title="Portfolio Summary"
				subtitle="Open Findings, active Alerts, and Claims in progress across every site and meter currently in RocketRide SQL."
				actions={
					<Button variant="secondary" small onClick={refreshAll}>
						Refresh
					</Button>
				}
			/>
			{error && <Banner variant="error">{error}</Banner>}
			{!error && !hasData && !loading && (
				<EmptyState title="No data yet" description="Run scripts/ingest_bills.py and scripts/recalculate_bills.py to populate RocketRide SQL." />
			)}
			{!error && (hasData || loading) && (
				<Card header="Live from RocketRide SQL">
					<MiniContainer>
						<MiniCard value={loading ? '…' : String(findings.rows?.[0]?.n ?? 0)} label="Open Findings" />
						<MiniCard
							value={loading ? '…' : formatRupees(findings.rows?.[0]?.total_impact)}
							label="Total disputed impact"
							color="var(--rr-color-warning)"
						/>
						<MiniCard value={loading ? '…' : String(alerts.rows?.[0]?.n ?? 0)} label="Active Alerts" />
						<MiniCard
							value={loading ? '…' : String(claims.rows?.[0]?.n ?? 0)}
							label="Claims in progress"
							color="var(--rr-color-info)"
						/>
					</MiniContainer>
				</Card>
			)}
		</div>
	);
};

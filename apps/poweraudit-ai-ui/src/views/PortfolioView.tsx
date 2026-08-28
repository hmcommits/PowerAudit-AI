// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import React from 'react';
import { Banner, Button, Card, ContentHeader, EmptyState, MiniCard, MiniContainer } from 'shell';
import { useSqlQuery } from '../lib/useSqlQuery';
import { BADGE_COLORS, FINDING_TYPE_VARIANT, FindingTypeBadge, LoadingState, MoneyValue, SUBTLE_TEXT_STYLE } from '../lib/uiKit';

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
// Presentation-only breakdown for the "at a glance" chart below the top
// metrics - a LEFT JOIN against the three known Finding types (Section 3's
// enum, see calculators/variance_detector.py) so all three always render
// as a stable set of bars, even when a type has zero findings yet, rather
// than the chart's shape jumping around as data changes.
const IMPACT_BY_TYPE_SQL = `
	SELECT t.type, COALESCE(g.n, 0) AS n, COALESCE(g.total_impact, 0) AS total_impact
	FROM (VALUES ('md-penalty'), ('pf-penalty'), ('math-error')) AS t(type)
	LEFT JOIN (
		SELECT type, count(*) AS n, SUM(rupee_impact) FILTER (WHERE rupee_impact > 0) AS total_impact
		FROM finding GROUP BY type
	) g ON g.type = t.type
	ORDER BY t.type
`;

interface CountRow {
	n: number;
	total_impact?: number;
}

interface TypeImpactRow {
	type: string;
	n: number;
	total_impact: number;
}

export const PortfolioView: React.FC = () => {
	const findings = useSqlQuery<CountRow>(OPEN_FINDINGS_SQL);
	const alerts = useSqlQuery<CountRow>(ALERTS_SQL);
	const claims = useSqlQuery<CountRow>(CLAIMS_IN_PROGRESS_SQL);
	const typeImpact = useSqlQuery<TypeImpactRow>(IMPACT_BY_TYPE_SQL);

	const loading = findings.loading || alerts.loading || claims.loading;
	const retrying = findings.retrying || alerts.retrying || claims.retrying;
	const error = findings.error ?? alerts.error ?? claims.error;

	const refreshAll = () => {
		void findings.refetch();
		void alerts.refetch();
		void claims.refetch();
		void typeImpact.refetch();
	};

	const hasData = findings.rows && alerts.rows && claims.rows;
	const maxTypeImpact = Math.max(1, ...(typeImpact.rows ?? []).map((r) => r.total_impact));

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
				<>
					{/* The rupee-impact figure is the actual point of this product -
					    it gets its own hero card (a much larger, accent-colored
					    number) instead of sitting as one same-sized tile among four,
					    the way it did before this pass. */}
					<Card>
						<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, flexWrap: 'wrap' }}>
							<div>
								<div style={SUBTLE_TEXT_STYLE}>Total disputed impact</div>
								<div style={{ marginTop: 4 }}>
									{loading && !findings.rows ? (
										<span style={{ fontSize: 32, fontWeight: 700, color: 'var(--rr-text-secondary)' }}>{retrying ? 'Reconnecting…' : '…'}</span>
									) : (
										<MoneyValue value={findings.rows?.[0]?.total_impact ?? 0} size="xl" />
									)}
								</div>
								<div style={{ marginTop: 4, ...SUBTLE_TEXT_STYLE }}>across {loading && !findings.rows ? '…' : findings.rows?.[0]?.n ?? 0} open finding(s)</div>
							</div>
							<MiniContainer columns={2}>
								<MiniCard value={loading && !alerts.rows ? '…' : String(alerts.rows?.[0]?.n ?? 0)} label="Active Alerts" />
								<MiniCard value={loading && !claims.rows ? '…' : String(claims.rows?.[0]?.n ?? 0)} label="Claims in progress" color="var(--rr-color-info)" />
							</MiniContainer>
						</div>
					</Card>

					<Card header="Disputed impact by finding type">
						{typeImpact.error && <Banner variant="error">{typeImpact.error}</Banner>}
						{!typeImpact.error && typeImpact.loading && !typeImpact.rows && (
							<LoadingState label={typeImpact.retrying ? 'Reconnecting…' : 'Loading breakdown…'} />
						)}
						{!typeImpact.error && typeImpact.rows && (
							<div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
								{typeImpact.rows.map((row) => {
									const pct = row.total_impact > 0 ? Math.max((row.total_impact / maxTypeImpact) * 100, 2) : 0;
									const barColor = BADGE_COLORS[FINDING_TYPE_VARIANT[row.type] ?? 'muted'].fg;
									return (
										<div key={row.type} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
											<div style={{ width: 120 }}>
												<FindingTypeBadge type={row.type} />
											</div>
											<div style={{ flex: 1, background: 'var(--rr-surface-secondary, rgba(128,128,128,0.15))', borderRadius: 4, height: 22, overflow: 'hidden' }}>
												<div style={{ width: `${pct}%`, background: barColor, height: '100%', transition: 'width 200ms ease' }} />
											</div>
											<div style={{ width: 110, textAlign: 'right' }}>
												<MoneyValue value={row.total_impact} size="sm" />
											</div>
											<div style={{ width: 90, textAlign: 'right', ...SUBTLE_TEXT_STYLE }}>
												{row.n} finding{row.n === 1 ? '' : 's'}
											</div>
										</div>
									);
								})}
							</div>
						)}
					</Card>
				</>
			)}
		</div>
	);
};

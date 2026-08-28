// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import React, { useState } from 'react';
import { Banner, Button, Card, MiniCard, MiniContainer, Question, useShellConnection } from 'shell';
import { useSqlQuery } from '../lib/useSqlQuery';
import { scanForRisks, type ScanSummary } from '../lib/trendScan';
import trendRecommendationPipe from '../../../../pipelines/trend-recommendation.pipe';
import {
	BADGE_COLORS,
	Badge,
	EmptyStateCard,
	FINDING_TYPE_VARIANT,
	FindingTypeBadge,
	InfoTip,
	LoadingState,
	MoneyValue,
	SUBTLE_TEXT_STYLE,
	Term,
	ViewShell,
} from '../lib/uiKit';

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

	const { client } = useShellConnection();
	const [scanning, setScanning] = useState(false);
	const [scanSummary, setScanSummary] = useState<ScanSummary | null>(null);
	const [scanError, setScanError] = useState<string | null>(null);

	/** Feature 3, from the UI: run the same detection scan
	 * scripts/scan_trend_alerts.py runs, across every meter, writing real
	 * Alert rows. The CrewAI wording step is a real pipeline the browser can
	 * call, so it's passed in here rather than reimplemented - and if it
	 * fails (free-tier quota is the likely cause), trendScan falls back to a
	 * deterministic description so the Alert is still written. */
	const handleScan = async () => {
		if (!client) return;
		setScanning(true);
		setScanError(null);
		setScanSummary(null);
		try {
			const recToken = (await client.use({ pipeline: trendRecommendationPipe as any, source: 'chat_1', useExisting: true, ttl: 1800, name: 'trend-recommendation-app' })).token;
			const summary = await scanForRisks(client, {
				composeRecommendation: async (prompt: string) => {
					const question = new Question();
					question.addQuestion(prompt);
					const response = await client.chat({ token: recToken, question });
					const answers = (response as { answers?: string[] }).answers ?? [];
					if (!answers[0]) throw new Error('no recommendation returned');
					return answers[0];
				},
			});
			setScanSummary(summary);
			void alerts.refetch();
		} catch (e) {
			setScanError(e instanceof Error ? e.message : String(e));
		} finally {
			setScanning(false);
		}
	};

	return (
		<ViewShell
			title="Portfolio Summary"
			subtitle="The headline number: how much money this portfolio appears to have been overcharged."
			actions={
				<Button variant="secondary" small onClick={refreshAll}>
					Refresh
				</Button>
			}
			intro={
				<>
					Electricity utilities charge commercial sites penalties when they draw more power than they agreed to (<Term term="MD penalty" />) or use it
					inefficiently (<Term term="PF penalty" />). Those charges are often wrong. PowerAudit AI re-checks every bill against the utility’s own tariff
					rules and totals up what looks recoverable. <strong>This page is the portfolio-wide summary</strong> — the total across all sites, and which kind
					of penalty is costing the most.
				</>
			}
		>
			{error && <Banner variant="error">{error}</Banner>}
			{!error && !hasData && !loading && (
				<EmptyStateCard
					title="No bills audited yet"
					description="Once electricity bills are uploaded, this page will show how much money looks recoverable across every site. Use the Upload Bill tab to add one."
				/>
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
								<div style={SUBTLE_TEXT_STYLE}>
									Money potentially recoverable
									<InfoTip text="The total rupee value of billing errors found so far - money these sites appear to have been overcharged and could claim back from their utility." />
								</div>
								<div style={{ marginTop: 4 }}>
									{loading && !findings.rows ? (
										<span style={{ fontSize: 32, fontWeight: 700, color: 'var(--rr-text-secondary)' }}>{retrying ? 'Reconnecting…' : '…'}</span>
									) : (
										<MoneyValue value={findings.rows?.[0]?.total_impact ?? 0} size="xl" />
									)}
								</div>
								<div style={{ marginTop: 4, ...SUBTLE_TEXT_STYLE }}>
									found across {loading && !findings.rows ? '…' : findings.rows?.[0]?.n ?? 0} billing error(s) not yet resolved
								</div>
							</div>
							<MiniContainer columns={2}>
								<MiniCard value={loading && !alerts.rows ? '…' : String(alerts.rows?.[0]?.n ?? 0)} label="Early warnings" />
								<MiniCard value={loading && !claims.rows ? '…' : String(claims.rows?.[0]?.n ?? 0)} label="Refund claims open" color="var(--rr-color-info)" />
							</MiniContainer>
						</div>
					</Card>

					<Card header="Where the money is going">
						<div style={{ marginBottom: 12, ...SUBTLE_TEXT_STYLE }}>
							Which kind of billing error accounts for the most money. <Term term="MD penalty" /> is charged for drawing too much power at once;{' '}
							<Term term="PF penalty" /> for using power inefficiently; <Term term="Math error" /> means the bill’s own numbers don’t add up.
						</div>
						{typeImpact.error && <Banner variant="error">{typeImpact.error}</Banner>}
						{!typeImpact.error && typeImpact.loading && !typeImpact.rows && (
							<LoadingState label={typeImpact.retrying ? 'Reconnecting…' : 'Adding up penalties by type…'} />
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
											<div style={{ width: 100, textAlign: 'right', ...SUBTLE_TEXT_STYLE }}>
												on {row.n} bill{row.n === 1 ? '' : 's'}
											</div>
										</div>
									);
								})}
							</div>
						)}
					</Card>

					<Card
						header="Predict future penalties"
						headerActions={
							<Button small onClick={handleScan} disabled={scanning || !client}>
								{scanning ? 'Scanning…' : 'Scan for Risks'}
							</Button>
						}
					>
						<div style={SUBTLE_TEXT_STYLE}>
							Everything above is money <em>already</em> lost on bills you’ve received. This looks <strong>forward</strong> instead: it fits a trend line
							through each meter’s recent history and flags the ones heading for a penalty they haven’t incurred yet — so you can act before the bill
							arrives, not after. Anything found is saved against that meter and explained in Site Drill-down.
						</div>

						{scanError && (
							<div style={{ marginTop: 12 }}>
								<Banner variant="error">Scan failed: {scanError}</Banner>
							</div>
						)}
						{scanning && (
							<div style={{ marginTop: 12 }}>
								<LoadingState label="Fitting trend lines across every meter…" />
							</div>
						)}
						{scanSummary && !scanning && (
							<div style={{ marginTop: 12 }}>
								<Banner variant={scanSummary.alertsWritten > 0 ? 'warning' : 'info'}>
									Checked {scanSummary.metersScanned} meter{scanSummary.metersScanned === 1 ? '' : 's'} —{' '}
									{scanSummary.alertsWritten > 0
										? `${scanSummary.alertsWritten} heading toward a penalty. Open Site Drill-down for the full explanation.`
										: 'none are currently trending toward a penalty.'}
								</Banner>
								{scanSummary.meters
									.flatMap((m) => m.alerts)
									.map((a) => (
										<div key={a.alertId} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '8px 0' }}>
											<Badge
												variant={a.trendType === 'cd-breach-risk' ? 'error' : 'warning'}
												label={a.trendType === 'cd-breach-risk' ? 'Demand breach' : 'Power factor'}
											/>
											<div style={{ flex: 1, minWidth: 0 }}>
												<div style={{ fontWeight: 600 }}>
													{a.meterId} — projected cost <MoneyValue value={a.projectedImpact} size="sm" />
												</div>
												<div style={SUBTLE_TEXT_STYLE}>{a.detail}</div>
											</div>
										</div>
									))}
							</div>
						)}
					</Card>
				</>
			)}
		</ViewShell>
	);
};

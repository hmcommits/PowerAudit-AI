// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import React, { useMemo, useState } from 'react';
import { Banner, Button, Card, CardDataGrid, EmptyState, InputField, useShellConnection } from 'shell';
import type { GridColumnDefinition, RocketRideClient } from 'shell';
import { useSqlQuery } from '../lib/useSqlQuery';
import { parseLineItems } from '../lib/db';
import { approveClaimAction } from '../lib/claimActions';
import { runWhatIf, type WhatIfOutcome } from '../lib/trendScan';
import { Badge, ClaimStatusBadge, FindingTypeBadge, LoadingState, MoneyValue, SECTION_LABEL_STYLE, SUBTLE_TEXT_STYLE, Term, ViewShell, findingTypeHtml, moneyHtml } from '../lib/uiKit';

interface MeterRow {
	site_id: string;
	site_name: string;
	meter_id: string;
	discom: string;
	tariff_category: string;
	contract_demand_kva: number;
}

// Index signatures below are for CardDataGrid's Record<string, unknown>[]
// `data` prop - tsc's structural check requires it explicitly, even though
// every field is also declared for our own type safety when reading rows.

interface BillRow {
	[key: string]: unknown;
	bill_id: string;
	period_start: string;
	period_end: string;
	recorded_md: number | null;
	recorded_pf: number | null;
	total_due: number | null;
	needs_review: boolean;
	source_doc_ref: string | null;
	line_items: unknown;
}

interface FindingRow {
	[key: string]: unknown;
	finding_id: string;
	bill_id: string;
	type: string;
	rupee_impact: number | null;
	confidence: number | null;
	tariff_citation: string | null;
	period_start: string;
}

interface AlertRow {
	[key: string]: unknown;
	alert_id: string;
	trend_type: string;
	projected_impact: number | null;
	recommendation: string | null;
	created_at: string;
}

interface ClaimRow {
	[key: string]: unknown;
	claim_id: string;
	finding_id: string;
	status: string;
	contract_impacting: boolean;
	approver: string | null;
	credited_amount: number | null;
	draft_packet: string | null;
	finding_type: string;
	rupee_impact: number | null;
}

const METERS_SQL = `
	SELECT s.site_id, s.name AS site_name, m.meter_id, m.discom, m.tariff_category, m.contract_demand_kva
	FROM site s JOIN meter m ON m.site_id = s.site_id
	ORDER BY s.site_id, m.meter_id
`;

export const DrilldownView: React.FC = () => {
	const meters = useSqlQuery<MeterRow>(METERS_SQL);
	const [selected, setSelected] = useState<string | null>(null);

	const activeMeterId = selected ?? meters.rows?.[0]?.meter_id ?? null;
	const activeMeter = meters.rows?.find((m) => m.meter_id === activeMeterId) ?? null;

	const bills = useSqlQuery<BillRow>(
		`SELECT bill_id, period_start, period_end, recorded_md, recorded_pf, total_due, needs_review, source_doc_ref, line_items
		 FROM bill WHERE meter_id = $1 ORDER BY period_start`,
		[activeMeterId ?? '__none__'],
	);
	const findings = useSqlQuery<FindingRow>(
		`SELECT f.finding_id, f.bill_id, f.type, f.rupee_impact, f.confidence, f.tariff_citation, b.period_start
		 FROM finding f JOIN bill b ON b.bill_id = f.bill_id WHERE f.meter_id = $1 ORDER BY b.period_start`,
		[activeMeterId ?? '__none__'],
	);
	const alerts = useSqlQuery<AlertRow>(
		`SELECT alert_id, trend_type, projected_impact, recommendation, created_at
		 FROM alert WHERE meter_id = $1 ORDER BY created_at`,
		[activeMeterId ?? '__none__'],
	);
	const claims = useSqlQuery<ClaimRow>(
		`SELECT c.claim_id, c.finding_id, c.status, c.contract_impacting, c.approver, c.credited_amount, c.draft_packet,
		        f.type AS finding_type, f.rupee_impact
		 FROM claim c JOIN finding f ON f.finding_id = c.finding_id WHERE f.meter_id = $1 ORDER BY c.created_at`,
		[activeMeterId ?? '__none__'],
	);

	const refreshAll = () => {
		void meters.refetch();
		void bills.refetch();
		void findings.refetch();
		void alerts.refetch();
		void claims.refetch();
	};

	const billColumns: GridColumnDefinition[] = useMemo(
		() => [
			{ title: 'Bill', field: 'bill_id', rrType: 'string', rrDefault: true, rrDescription: 'Bill record id - the source lineage for any Finding on this row.', tooltip: true, minWidth: 150 },
			{ title: 'Period', field: 'period_start', rrType: 'date', rrDefault: true, rrDescription: 'Billing period start date.' },
			{ title: 'MD (kVA)', field: 'recorded_md', rrType: 'number', rrDefault: true, rrDescription: 'Maximum Demand as printed on the bill.', minWidth: 90 },
			{ title: 'PF', field: 'recorded_pf', rrType: 'number', rrDefault: true, rrDescription: 'Power Factor as printed on the bill.', minWidth: 70 },
			{ title: 'Total due', field: 'total_due', rrType: 'number', rrDefault: true, rrDescription: 'Total amount due as billed.', minWidth: 100 },
			{
				title: 'Review?',
				field: 'needs_review',
				rrType: 'boolean',
				rrDefault: true,
				rrDescription: "Feature 1's Schema Validate flag - true when extraction found something implausible or self-corrected a value.",
				minWidth: 80,
			},
			{
				// Hidden from the default view - this is a long concatenated
				// "description: amount" string per bill and was crowding out
				// every other column (Review?/MD/PF headers were rendering
				// cut down to a single letter). Still available via the
				// grid's column toggle for anyone who needs it, full text on
				// hover once shown (rrDescription doubles as the toggle-list
				// tooltip).
				title: 'Line items',
				field: 'line_items',
				rrType: 'string',
				rrDescription: 'Billed line items as extracted (description: amount).',
				tooltip: true,
				formatter: (cell: any) =>
					parseLineItems(cell.getValue())
						.map((item) => `${item.description ?? '?'}: ${item.amount ?? '?'}`)
						.join(', ') || '-',
			},
			{ title: 'Source document', field: 'source_doc_ref', rrType: 'string', rrDescription: 'The ingested file this bill came from.', tooltip: true },
		],
		[],
	);

	const findingColumns: GridColumnDefinition[] = useMemo(
		() => [
			{ title: 'Finding', field: 'finding_id', rrType: 'string', rrDefault: true, rrDescription: 'Finding record id.', tooltip: true, minWidth: 150 },
			{
				title: 'Bill',
				field: 'bill_id',
				rrType: 'string',
				rrDefault: true,
				rrDescription: 'Lineage: the exact Bill record this Finding was calculated from.',
				tooltip: true,
				minWidth: 130,
			},
			{
				title: 'Type',
				field: 'type',
				rrType: 'enum',
				rrDefault: true,
				rrDescription: "Finding category (Section 3's enum) - md-penalty, pf-penalty, or math-error.",
				formatter: (cell: any) => findingTypeHtml(cell.getValue()),
			},
			{
				title: 'Rupee impact',
				field: 'rupee_impact',
				rrType: 'number',
				rrDefault: true,
				rrDescription:
					'Positive = consumer overcharged, a real actionable finding worth disputing. Negative = undercharged - not disputable, shown muted so it does not read as an action item.',
				minWidth: 110,
				// Muted/gray for a negative (undercharge, not disputable) impact;
				// large/bold/accented for a positive (real, dispute-worthy) one -
				// this is the number the whole product exists to surface, so it
				// should never look like plain metadata (see uiKit.tsx's
				// moneyHtml, reused across every view).
				formatter: (cell: any) => moneyHtml(cell.getValue(), { mutedIfNonPositive: true }),
			},
			{ title: 'Confidence', field: 'confidence', rrType: 'number', rrDefault: true, rrDescription: 'Extraction confidence backing this Finding, 0-1.' },
			{ title: 'Tariff citation', field: 'tariff_citation', rrType: 'string', rrDescription: 'The tariff clause backing the recalculation (stub pending the Vector fix - see docs/CLAUDE.md Backlog).', tooltip: true },
		],
		[],
	);

	const { client } = useShellConnection();

	return (
		// scrollBody={false}: this view manages its own two independently
		// scrolling columns, so ViewShell must NOT wrap them in a third
		// scroller. Converting to ViewShell is the actual fix for the
		// Alerts/What-If/Claims sections not scrolling: the hand-rolled root
		// this replaced set height:100% but no minHeight:0, so the root
		// refused to shrink below its content and the right column's
		// overflowY:auto never engaged - the broken link was the ROOT, not
		// the section divs.
		<ViewShell
			title="Site Drill-down"
			subtitle="One meter's full story: what it was billed, what we found, what's coming, and what's being claimed back."
			scrollBody={false}
			actions={
				<Button variant="secondary" small onClick={refreshAll}>
					Refresh
				</Button>
			}
		>
			{meters.error && <Banner variant="error">{meters.error}</Banner>}
			{!meters.error && meters.loading && !meters.rows && <LoadingState label={meters.retrying ? 'Reconnecting…' : 'Loading meters…'} />}
			{!meters.error && meters.rows && meters.rows.length === 0 && (
				<EmptyState title="No meters yet" description="Run scripts/setup_schema.py and scripts/seed_meters.py to populate RocketRide SQL." />
			)}
			{!meters.error && meters.rows && meters.rows.length > 0 && (
				<div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0 }}>
					<div style={{ width: 260, flexShrink: 0, minHeight: 0, display: 'flex' }}>
						<Card header="Meters" noBodyPadding fill>
						<div style={{ overflowY: 'auto', height: '100%' }}>
							{Object.entries(
								meters.rows.reduce<Record<string, MeterRow[]>>((acc, m) => {
									(acc[m.site_name] ??= []).push(m);
									return acc;
								}, {}),
							).map(([siteName, siteMeters]) => (
								<div key={siteName}>
									<div style={{ padding: '8px 12px', ...SECTION_LABEL_STYLE }}>{siteName}</div>
									{siteMeters.map((m) => (
										<div
											key={m.meter_id}
											onClick={() => setSelected(m.meter_id)}
											style={{
												padding: '8px 12px',
												cursor: 'pointer',
												background: m.meter_id === activeMeterId ? 'var(--rr-surface-selected, var(--rr-surface-hover))' : undefined,
												borderLeft: m.meter_id === activeMeterId ? '3px solid var(--rr-color-brand)' : '3px solid transparent',
											}}
										>
											<div style={{ fontWeight: 600 }}>{m.meter_id}</div>
											<div style={SUBTLE_TEXT_STYLE}>
												{m.discom} · {m.tariff_category} · CD {m.contract_demand_kva} kVA
											</div>
										</div>
									))}
								</div>
							))}
							</div>
						</Card>
					</div>

					<div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0, minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>
						{activeMeter && (
							<Banner variant="info">
								{activeMeter.meter_id} — {activeMeter.discom}, {activeMeter.tariff_category}, Contract Demand {activeMeter.contract_demand_kva} kVA, site{' '}
								{activeMeter.site_name}
							</Banner>
						)}
						<CardDataGridSection title="Bills" columns={billColumns} rows={bills.rows} error={bills.error} loading={bills.loading} retrying={bills.retrying} emptyLabel="No bills for this meter." />
						<CardDataGridSection
							title="Findings"
							columns={findingColumns}
							rows={findings.rows}
							error={findings.error}
							loading={findings.loading}
							retrying={findings.retrying}
							emptyLabel="No findings for this meter."
						/>
						<AlertsPanel rows={alerts.rows} error={alerts.error} loading={alerts.loading} retrying={alerts.retrying} />
						<WhatIfPanel client={client} meterId={activeMeterId} contractDemandKva={activeMeter?.contract_demand_kva ?? null} />
						<ClaimsPanel rows={claims.rows} error={claims.error} loading={claims.loading} retrying={claims.retrying} client={client} onApproved={() => void claims.refetch()} />
					</div>
				</div>
			)}
		</ViewShell>
	);
};

function CardDataGridSection<T extends Record<string, unknown>>(props: {
	title: string;
	columns: GridColumnDefinition[];
	rows: T[] | null;
	error: string | null;
	loading: boolean;
	retrying: boolean;
	emptyLabel: string;
}): React.ReactElement {
	const { title, columns, rows, error, loading, retrying, emptyLabel } = props;
	if (error) {
		return (
			<Card header={title}>
				<Banner variant="error">{error}</Banner>
			</Card>
		);
	}
	if (loading && !rows) {
		return (
			<Card header={title}>
				<LoadingState label={retrying ? 'Reconnecting…' : `Loading ${title.toLowerCase()}…`} />
			</Card>
		);
	}
	if (rows && rows.length === 0) {
		return (
			<Card header={title}>
				<EmptyState title={emptyLabel} />
			</Card>
		);
	}
	return <CardDataGrid tableId={`drilldown-${title.toLowerCase()}`} title={title} columns={columns} data={rows ?? []} paginate={false} noSearch />;
}

const TREND_LABEL: Record<string, { label: string; variant: 'error' | 'warning'; explain: React.ReactNode }> = {
	'cd-breach-risk': {
		label: 'Demand breach ahead',
		variant: 'error',
		explain: (
			<>
				This meter’s peak power draw is climbing and is on track to pass the <Term term="Contract Demand" /> it agreed with the utility. Once it does,
				every unit above that limit is billed at a penalty rate. Acting before the crossover — raising the agreed limit, or moving load off the peak —
				avoids the charge entirely.
			</>
		),
	},
	'pf-decline-risk': {
		label: 'Power factor slipping',
		variant: 'warning',
		explain: (
			<>
				This meter’s <Term term="Power Factor" /> is falling toward the level where the utility starts adding a surcharge. It usually means capacitors
				need servicing. Fixing it early keeps the surcharge off future bills.
			</>
		),
	},
};

/**
 * Alerts are FORECASTS, not charges already incurred - the panel says so
 * explicitly, because a first-time reader has no way to tell the difference
 * between this and the Findings table above it (which IS money already
 * billed). Replaces the previous data-grid, whose columns gave a raw
 * trend_type enum and truncated the recommendation text.
 */
function AlertsPanel(props: { rows: AlertRow[] | null; error: string | null; loading: boolean; retrying: boolean }): React.ReactElement {
	const { rows, error, loading, retrying } = props;
	if (error) {
		return (
			<Card header="Early warnings">
				<Banner variant="error">{error}</Banner>
			</Card>
		);
	}
	if (loading && !rows) {
		return (
			<Card header="Early warnings">
				<LoadingState label={retrying ? 'Reconnecting…' : 'Loading early warnings…'} />
			</Card>
		);
	}
	if (rows && rows.length === 0) {
		return (
			<Card header="Early warnings">
				<EmptyState
					title="No penalties predicted for this meter"
					description="Nothing here means no worrying trend was detected. Use “Scan for Risks” on Portfolio Summary to check every meter — it needs at least 3 past bills to spot a trend."
				/>
			</Card>
		);
	}
	return (
		<Card header="Early warnings" noBodyPadding>
			<div style={{ padding: '12px 16px 0', ...SUBTLE_TEXT_STYLE }}>
				These are <strong>predictions, not charges you’ve been billed</strong>. Each one projects this meter’s recent trend forward to warn about a
				penalty it hasn’t incurred yet.
			</div>
			<div style={{ display: 'flex', flexDirection: 'column' }}>
				{(rows ?? []).map((alert, i) => {
					const meta = TREND_LABEL[alert.trend_type];
					return (
						<div key={alert.alert_id} style={{ padding: 16, borderTop: i === 0 ? undefined : '1px solid var(--rr-border-color, rgba(128,128,128,0.2))' }}>
							<div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
								<Badge variant={meta?.variant ?? 'muted'} label={meta?.label ?? alert.trend_type} />
								{alert.projected_impact !== null && alert.projected_impact > 0 && (
									<span style={SUBTLE_TEXT_STYLE}>
										projected cost if nothing changes: <MoneyValue value={alert.projected_impact} size="sm" />
									</span>
								)}
							</div>
							{meta && <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.55 }}>{meta.explain}</div>}
							{alert.recommendation && (
								<>
									<div style={{ marginTop: 10, ...SECTION_LABEL_STYLE }}>What to do</div>
									<div style={{ marginTop: 4, fontSize: 13, lineHeight: 1.55 }}>{alert.recommendation}</div>
								</>
							)}
						</div>
					);
				})}
			</div>
		</Card>
	);
}

/**
 * What-if: "what would raising Contract Demand to X have saved?". Runs the
 * same projection the risk scan uses (trendAnalysis.whatIfCdChange, ported
 * from calculators/what_if.py) and writes NOTHING - no Alert row - exactly
 * matching scripts/what_if_scenario.py.
 */
function WhatIfPanel(props: { client: RocketRideClient | null; meterId: string | null; contractDemandKva: number | null }): React.ReactElement {
	const { client, meterId, contractDemandKva } = props;
	const [value, setValue] = useState('');
	const [running, setRunning] = useState(false);
	const [outcome, setOutcome] = useState<WhatIfOutcome | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Reset whenever the selected meter changes - a projection for the
	// previously-selected meter must never linger under a new one's header.
	const [lastMeter, setLastMeter] = useState<string | null>(meterId);
	if (lastMeter !== meterId) {
		setLastMeter(meterId);
		setOutcome(null);
		setError(null);
		setValue('');
	}

	const hypothetical = Number(value);
	const canRun = !!client && !!meterId && Number.isFinite(hypothetical) && hypothetical > 0 && !running;

	const run = async () => {
		if (!client || !meterId) return;
		setRunning(true);
		setError(null);
		setOutcome(null);
		try {
			setOutcome(await runWhatIf(client, meterId, hypothetical));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setRunning(false);
		}
	};

	const r = outcome?.result;
	return (
		<Card header="What if we raised the agreed limit?">
			<div style={SUBTLE_TEXT_STYLE}>
				Try a different <Term term="Contract Demand" /> and see what it would cost or save. This only does the sums — it changes nothing and saves
				nothing.
				{contractDemandKva !== null && <> This meter’s current agreed limit is <strong>{contractDemandKva} kVA</strong>.</>}
			</div>
			<div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
				<InputField
					type="number"
					placeholder="New limit in kVA, e.g. 560"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					disabled={running}
					style={{ minWidth: 220 }}
				/>
				<Button small disabled={!canRun} onClick={run}>
					{running ? 'Calculating…' : 'Project cost'}
				</Button>
			</div>

			{error && (
				<div style={{ marginTop: 12 }}>
					<Banner variant="error">{error}</Banner>
				</div>
			)}

			{r && r.status === 'insufficient_data' && (
				<div style={{ marginTop: 12 }}>
					<Banner variant="info">This meter needs at least 3 past bills before a trend can be projected. It doesn’t have enough history yet.</Banner>
				</div>
			)}

			{r && r.status === 'ok' && (
				<div style={{ marginTop: 12 }}>
					<div style={SUBTLE_TEXT_STYLE}>
						Based on the recent trend, peak demand is projected to reach <strong>{r.projected_md_at_horizon} kVA</strong> in{' '}
						{r.warning_horizon_months} months.
					</div>
					<div style={{ marginTop: 10, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
						<div>
							<div style={SUBTLE_TEXT_STYLE}>Penalty at current {r.current_cd} kVA</div>
							<MoneyValue value={r.current_projected_penalty} size="lg" />
						</div>
						<div>
							<div style={SUBTLE_TEXT_STYLE}>Penalty at {r.hypothetical_cd} kVA</div>
							<MoneyValue value={r.hypothetical_projected_penalty} size="lg" />
						</div>
						<div>
							<div style={SUBTLE_TEXT_STYLE}>Difference</div>
							<MoneyValue value={r.projected_savings} size="lg" />
						</div>
					</div>
					<div style={{ marginTop: 10, ...SUBTLE_TEXT_STYLE }}>
						{(r.projected_savings ?? 0) > 0
							? `Raising the limit to ${r.hypothetical_cd} kVA would avoid about ${(r.projected_savings ?? 0).toLocaleString('en-IN')} rupees of penalty on the projected demand. Weigh that against any higher standing charge for the larger limit.`
							: 'That change would not reduce the projected penalty — the trend does not cross the limit either way.'}
					</div>
				</div>
			)}
		</Card>
	);
}

/**
 * Renders each claim as its own card with the FULL draft_packet text visible
 * (the whole reason that column exists is so an approver can read the real
 * dispute text, not just see a status badge - a data-grid cell truncates
 * this, so claims get their own panel instead of the CardDataGridSection
 * pattern used for Bills/Findings/Alerts). Pending-approval claims get an
 * inline Approve form; the actual guard lives in claimActions.ts's
 * approveClaimAction() (ported from calculators/claim_workflow.py), not in
 * this component - the Button being disabled is a UI nicety, not the
 * enforcement.
 */
function ClaimsPanel(props: {
	rows: ClaimRow[] | null;
	error: string | null;
	loading: boolean;
	retrying: boolean;
	client: RocketRideClient | null;
	onApproved: () => void;
}): React.ReactElement {
	const { rows, error, loading, retrying, client, onApproved } = props;
	if (error) {
		return (
			<Card header="Claims">
				<Banner variant="error">{error}</Banner>
			</Card>
		);
	}
	if (loading && !rows) {
		return (
			<Card header="Claims">
				<LoadingState label={retrying ? 'Reconnecting…' : 'Loading claims…'} />
			</Card>
		);
	}
	if (rows && rows.length === 0) {
		return (
			<Card header="Claims">
				<EmptyState title="No claims drafted for this meter." />
			</Card>
		);
	}
	return (
		<Card header="Claims" noBodyPadding>
			<div style={{ display: 'flex', flexDirection: 'column' }}>
				{(rows ?? []).map((claim, i) => (
					<ClaimCard key={claim.claim_id} claim={claim} client={client} onApproved={onApproved} isFirst={i === 0} />
				))}
			</div>
		</Card>
	);
}

function ClaimCard(props: { claim: ClaimRow; client: RocketRideClient | null; onApproved: () => void; isFirst: boolean }): React.ReactElement {
	const { claim, client, onApproved, isFirst } = props;
	const [approverName, setApproverName] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const canApprove = claim.status === 'pending_approval';
	const trimmedName = approverName.trim();

	const handleApprove = async () => {
		if (!client) return;
		setSubmitting(true);
		setError(null);
		try {
			await approveClaimAction(client, claim.claim_id, approverName);
			setApproverName('');
			onApproved();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div style={{ padding: 16, borderTop: isFirst ? undefined : '1px solid var(--rr-border-color, rgba(128,128,128,0.2))' }}>
			<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
				<div>
					<div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
						<MoneyValue value={claim.rupee_impact} size="lg" />
						<FindingTypeBadge type={claim.finding_type} />
						{claim.contract_impacting && <Badge variant="info" label="Contract impacting" />}
					</div>
					<div style={{ marginTop: 4, ...SUBTLE_TEXT_STYLE }}>
						{claim.claim_id} · from {claim.finding_id}
					</div>
				</div>
				<ClaimStatusBadge status={claim.status} />
			</div>

			<div style={{ marginTop: 12, ...SECTION_LABEL_STYLE }}>Draft dispute packet</div>
			<div
				style={{
					marginTop: 4,
					whiteSpace: 'pre-wrap',
					fontSize: 13,
					background: 'var(--rr-surface-secondary, rgba(128,128,128,0.08))',
					borderRadius: 6,
					padding: 10,
					maxHeight: 220,
					overflowY: 'auto',
				}}
			>
				{claim.draft_packet || '(no packet text on this claim)'}
			</div>

			{claim.approver && <div style={{ marginTop: 8, ...SUBTLE_TEXT_STYLE }}>Approved by: {claim.approver}</div>}
			{claim.credited_amount !== null && claim.credited_amount !== undefined && (
				<div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, ...SUBTLE_TEXT_STYLE }}>
					Credited: <MoneyValue value={claim.credited_amount} size="sm" />
				</div>
			)}

			{canApprove && (
				<div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
					<InputField
						placeholder="Approver's full name"
						value={approverName}
						onChange={(e) => setApproverName(e.target.value)}
						disabled={submitting}
						style={{ minWidth: 240 }}
					/>
					<Button small disabled={!trimmedName || submitting || !client} onClick={handleApprove}>
						{submitting ? 'Approving…' : 'Approve'}
					</Button>
				</div>
			)}
			{error && (
				<div style={{ marginTop: 8 }}>
					<Banner variant="error">{error}</Banner>
				</div>
			)}
		</div>
	);
}

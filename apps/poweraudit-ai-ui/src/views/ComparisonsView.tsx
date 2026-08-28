// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import React, { useMemo, useState } from 'react';
import { Banner, Button, Card, CardDataGrid, ToggleGroup } from 'shell';
import type { GridColumnDefinition } from 'shell';
import { useSqlQuery } from '../lib/useSqlQuery';
import { EmptyStateCard, LoadingState, MoneyValue, SUBTLE_TEXT_STYLE, Term, ViewShell, moneyHtml } from '../lib/uiKit';

interface MeterStatsRow {
	[key: string]: unknown;
	meter_id: string;
	site_name: string;
	discom: string;
	contract_demand_kva: number;
	avg_total_due: number | null;
	bill_count: number;
	penalty_count: number;
	total_overcharge_impact: number;
}

// Section 3's Bill has no energy-consumption (kWh) column, so a true
// cost-per-kWh figure isn't available from the data we capture. Rs. per
// kVA of Contract Demand is used instead - a real, defensible efficiency
// proxy, just not the same thing as cost-per-unit-of-energy. Labeled as
// such rather than silently implying a metric we can't back with real
// data (see docs/CLAUDE.md Backlog for the underlying schema gap).
const STATS_SQL = `
	SELECT
		m.meter_id, s.name AS site_name, m.discom, m.contract_demand_kva,
		AVG(b.total_due) AS avg_total_due,
		COUNT(DISTINCT b.bill_id) AS bill_count,
		COALESCE((SELECT COUNT(*) FROM finding f WHERE f.meter_id = m.meter_id AND f.type IN ('md-penalty', 'pf-penalty')), 0) AS penalty_count,
		COALESCE((SELECT SUM(f.rupee_impact) FROM finding f WHERE f.meter_id = m.meter_id AND f.rupee_impact > 0), 0) AS total_overcharge_impact
	FROM meter m
	JOIN site s ON s.site_id = m.site_id
	LEFT JOIN bill b ON b.meter_id = m.meter_id
	GROUP BY m.meter_id, s.name, m.discom, m.contract_demand_kva
`;

type Metric = 'total_overcharge_impact' | 'penalty_count' | 'cost_per_kva';

const METRIC_LABEL: Record<Metric, string> = {
	total_overcharge_impact: 'Total disputed impact (Rs.)',
	penalty_count: 'Penalty finding count',
	cost_per_kva: 'Avg cost per kVA of Contract Demand (Rs.)',
};

function costPerKva(row: MeterStatsRow): number {
	if (!row.contract_demand_kva) return 0;
	return (row.avg_total_due ?? 0) / row.contract_demand_kva;
}

function metricValue(row: MeterStatsRow, metric: Metric): number {
	if (metric === 'cost_per_kva') return costPerKva(row);
	return Number(row[metric] ?? 0);
}

export const ComparisonsView: React.FC = () => {
	const stats = useSqlQuery<MeterStatsRow>(STATS_SQL);
	const [metric, setMetric] = useState<Metric>('total_overcharge_impact');

	const ranked = useMemo(() => {
		const rows = stats.rows ?? [];
		return [...rows].sort((a, b) => metricValue(b, metric) - metricValue(a, metric));
	}, [stats.rows, metric]);

	const maxValue = ranked.length > 0 ? Math.max(...ranked.map((r) => metricValue(r, metric)), 1) : 1;

	const columns: GridColumnDefinition[] = useMemo(
		() => [
			{ title: 'Meter', field: 'meter_id', rrType: 'string', rrDefault: true, rrDescription: 'Meter id.' },
			{ title: 'Site', field: 'site_name', rrType: 'string', rrDefault: true, rrDescription: 'Owning site.' },
			{ title: 'DISCOM', field: 'discom', rrType: 'string', rrDefault: true, rrDescription: 'Distribution company.' },
			{ title: 'Contract Demand (kVA)', field: 'contract_demand_kva', rrType: 'number', rrDefault: true, rrDescription: 'Agreed maximum demand.' },
			{ title: 'Bills', field: 'bill_count', rrType: 'number', rrDefault: true, rrDescription: 'Number of Bill records on file for this meter.' },
			{ title: 'Penalty findings', field: 'penalty_count', rrType: 'number', rrDefault: true, rrDescription: 'Count of md-penalty/pf-penalty Findings for this meter.' },
			{
				title: 'Total disputed impact',
				field: 'total_overcharge_impact',
				rrType: 'number',
				rrDefault: true,
				rrDefaultSort: 'desc',
				rrDescription: 'Sum of positive (overcharge) rupee_impact across this meter\'s Findings - the actual point of this product, so it renders larger/bolder/accented rather than a plain number.',
				formatter: (cell: any) => moneyHtml(cell.getValue()),
			},
			{
				title: 'Avg cost / kVA',
				field: 'cost_per_kva',
				rrType: 'number',
				rrDefault: true,
				rrDescription: 'Average Bill total_due divided by Contract Demand - an efficiency proxy (no kWh column exists to compute true cost-per-unit-of-energy).',
				formatter: (cell: any) => moneyHtml(cell.getValue()),
			},
		],
		[],
	);

	const gridData = ranked.map((row) => ({ ...row, cost_per_kva: Math.round(costPerKva(row)) }));

	return (
		<ViewShell
			title="Comparisons"
			subtitle="Which sites are losing the most money — worst first."
			actions={
				<Button variant="secondary" small onClick={() => void stats.refetch()}>
					Refresh
				</Button>
			}
			intro={
				<>
					Every bar below is one electricity <Term term="Meter" /> — a single connection at one of your sites. They’re ranked worst-first, so the
					sites costing you the most sit at the top. Use the toggle to re-rank by total money at stake, by how <em>often</em> a site gets penalised,
					or by cost efficiency relative to the capacity it pays for (its <Term term="Contract Demand" />).
				</>
			}
		>
			{stats.error && <Banner variant="error">{stats.error}</Banner>}
			{!stats.error && stats.loading && !stats.rows && <LoadingState label={stats.retrying ? 'Reconnecting…' : 'Ranking sites by money at stake…'} />}
			{!stats.error && stats.rows && stats.rows.length === 0 && (
				<EmptyStateCard
					title="No meters set up yet"
					description="Once sites and their electricity meters are registered, this page ranks them worst-first so the biggest problems surface immediately."
				/>
			)}
			{!stats.error && ranked.length > 0 && (
				<>
					<Card
						header="Ranked by"
						headerActions={
							<ToggleGroup
								options={[
									{ id: 'total_overcharge_impact', label: 'Disputed impact' },
									{ id: 'penalty_count', label: 'Penalty frequency' },
									{ id: 'cost_per_kva', label: 'Cost per kVA' },
								]}
								value={metric}
								onChange={(id) => setMetric(id as Metric)}
							/>
						}
					>
						<div style={{ marginBottom: 12, ...SUBTLE_TEXT_STYLE }}>
							{METRIC_LABEL[metric]}, worst first — {ranked.length} meters
						</div>
						{/* Every meter visible at once - no inner scroll. The rows
						    are deliberately compact (18px bars, 6px gaps) so all 15
						    fit without one; the page's own scroller reaches the
						    table below. An earlier version capped this at 340px,
						    which meant scrolling inside the chart to see the worst
						    offenders - the opposite of what a ranking is for. */}
						<div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
							{ranked.map((row, idx) => {
								const value = metricValue(row, metric);
								const pct = maxValue > 0 ? Math.max((value / maxValue) * 100, value > 0 ? 2 : 0) : 0;
								const color = idx < 3 ? 'var(--rr-color-error)' : idx < 6 ? 'var(--rr-color-warning)' : 'var(--rr-color-info)';
								const isMoney = metric !== 'penalty_count';
								return (
									<div key={row.meter_id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
										<div style={{ width: 74, fontWeight: 600, fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
											#{idx + 1} {row.meter_id}
										</div>
										<div style={{ flex: 1, background: 'var(--rr-surface-secondary, rgba(128,128,128,0.15))', borderRadius: 4, height: 18, overflow: 'hidden' }}>
											<div style={{ width: `${pct}%`, background: color, height: '100%', transition: 'width 200ms ease' }} />
										</div>
										<div style={{ width: 120, textAlign: 'right' }}>
											{isMoney ? <MoneyValue value={value} size="sm" /> : (
												<span style={{ fontSize: 15, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
											)}
										</div>
									</div>
								);
							})}
						</div>
					</Card>
					{/* Bounded so the full table is always reachable and scrolls
					    within itself, rather than running off the bottom. */}
					<div style={{ maxHeight: 420, overflowY: 'auto' }}>
						<CardDataGrid tableId="comparisons" title="All meters" columns={columns} data={gridData} paginate={false} noSearch />
					</div>
				</>
			)}
		</ViewShell>
	);
};

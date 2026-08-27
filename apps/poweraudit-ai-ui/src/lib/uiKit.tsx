// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Shared presentation primitives for the four views (Upload, Portfolio,
 * Drilldown, Comparisons) - badges, money formatting, and a couple of
 * layout tokens - so status/type/money treatment looks identical no matter
 * which view it appears in, instead of each view re-inventing its own
 * ad hoc inline styles. Presentation only: no calculator or data-fetching
 * logic lives here.
 *
 * Two forms of most things are exported: a React component for JSX
 * contexts, and an `xHtml` function returning a raw HTML string for
 * CardDataGrid's Tabulator-based `formatter` callbacks, which render
 * outside React (see ROCKETRIDE_UI_COMPONENTS.md's "Tabulator formatters
 * build DOM outside React").
 */

import React from 'react';

export type BadgeVariant = 'success' | 'info' | 'warning' | 'error' | 'muted';

export const BADGE_COLORS: Record<BadgeVariant, { bg: string; fg: string }> = {
	success: { bg: 'var(--rr-color-success-bg, rgba(34,197,94,0.15))', fg: 'var(--rr-color-success, #16a34a)' },
	info: { bg: 'var(--rr-color-info-bg, rgba(59,130,246,0.15))', fg: 'var(--rr-color-info, #2563eb)' },
	warning: { bg: 'var(--rr-color-warning-bg, rgba(234,179,8,0.15))', fg: 'var(--rr-color-warning, #ca8a04)' },
	error: { bg: 'var(--rr-color-error-bg, rgba(239,68,68,0.15))', fg: 'var(--rr-color-error, #dc2626)' },
	muted: { bg: 'var(--rr-surface-secondary, rgba(128,128,128,0.15))', fg: 'var(--rr-text-secondary)' },
};

// The one accent color used everywhere a rupee-impact figure needs to read
// as "the point of this product" - matches the color PortfolioView already
// used for its "Total disputed impact" metric before this pass.
export const MONEY_ACCENT = 'var(--rr-color-warning, #ca8a04)';

export const CLAIM_STATUS_VARIANT: Record<string, BadgeVariant> = {
	draft: 'muted',
	pending_approval: 'warning',
	approved_ready_to_file: 'info',
	filed: 'info',
	under_discom_review: 'warning',
	credited: 'success',
	denied: 'error',
};

// Section 3's three Finding types (calculators/variance_detector.py). Color
// is purely categorical, not a severity ranking - md-penalty is flagged
// error/red because it is typically the largest per-bill impact, pf-penalty
// warning/amber, math-error info/blue as a data-consistency flag rather
// than a tariff penalty.
export const FINDING_TYPE_VARIANT: Record<string, BadgeVariant> = {
	'md-penalty': 'error',
	'pf-penalty': 'warning',
	'math-error': 'info',
};

export const FINDING_TYPE_LABEL: Record<string, string> = {
	'md-penalty': 'MD Penalty',
	'pf-penalty': 'PF Penalty',
	'math-error': 'Math Error',
};

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function badgeStyle(variant: BadgeVariant): string {
	const c = BADGE_COLORS[variant] ?? BADGE_COLORS.muted;
	return `display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;text-transform:uppercase;white-space:nowrap;background:${c.bg};color:${c.fg};`;
}

/** Tabulator-formatter form of {@link Badge} - returns an HTML string. */
export function badgeHtml(variant: BadgeVariant, label: string): string {
	return `<span style="${badgeStyle(variant)}">${escapeHtml(label)}</span>`;
}

export function Badge({ variant, label }: { variant: BadgeVariant; label: string }): React.ReactElement {
	const c = BADGE_COLORS[variant] ?? BADGE_COLORS.muted;
	return (
		<span
			style={{
				display: 'inline-block',
				padding: '2px 8px',
				borderRadius: 999,
				fontSize: 11,
				fontWeight: 700,
				textTransform: 'uppercase',
				whiteSpace: 'nowrap',
				background: c.bg,
				color: c.fg,
			}}
		>
			{label}
		</span>
	);
}

export function ClaimStatusBadge({ status }: { status: string }): React.ReactElement {
	return <Badge variant={CLAIM_STATUS_VARIANT[status] ?? 'muted'} label={status} />;
}

export function claimStatusHtml(status: unknown): string {
	const s = String(status ?? '');
	return badgeHtml(CLAIM_STATUS_VARIANT[s] ?? 'muted', s);
}

export function FindingTypeBadge({ type }: { type: string }): React.ReactElement {
	return <Badge variant={FINDING_TYPE_VARIANT[type] ?? 'muted'} label={FINDING_TYPE_LABEL[type] ?? type} />;
}

export function findingTypeHtml(type: unknown): string {
	const t = String(type ?? '');
	return badgeHtml(FINDING_TYPE_VARIANT[t] ?? 'muted', FINDING_TYPE_LABEL[t] ?? t);
}

export function formatRupees(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return '-';
	return `Rs. ${Math.round(value).toLocaleString('en-IN')}`;
}

export type MoneySize = 'sm' | 'md' | 'lg' | 'xl';
const MONEY_SIZE_PX: Record<MoneySize, number> = { sm: 13, md: 15, lg: 20, xl: 32 };

/**
 * The rupee-impact figure is the actual point of this product - render it
 * larger/bolder/color-accented everywhere, never styled like a plain id or
 * timestamp. `mutedIfNonPositive` grays out a non-positive (undercharge,
 * per Feature 4's own materiality logic - see claimWorkflow.ts) impact so
 * it doesn't read as an action item.
 */
export function MoneyValue({
	value,
	size = 'md',
	mutedIfNonPositive = false,
}: {
	value: number | null | undefined;
	size?: MoneySize;
	mutedIfNonPositive?: boolean;
}): React.ReactElement {
	const num = typeof value === 'number' ? value : Number(value);
	const finite = Number.isFinite(num);
	const muted = mutedIfNonPositive && finite && num <= 0;
	return (
		<span
			style={{
				fontSize: MONEY_SIZE_PX[size],
				fontWeight: size === 'sm' ? 600 : 700,
				fontVariantNumeric: 'tabular-nums',
				color: muted ? 'var(--rr-text-secondary)' : MONEY_ACCENT,
			}}
		>
			{finite ? formatRupees(num) : '-'}
		</span>
	);
}

/** Tabulator-formatter form of {@link MoneyValue} - returns an HTML string. */
export function moneyHtml(raw: unknown, opts?: { mutedIfNonPositive?: boolean }): string {
	const num = Number(raw);
	if (!Number.isFinite(num)) return raw === null || raw === undefined ? '-' : String(raw);
	const muted = !!opts?.mutedIfNonPositive && num <= 0;
	const style = muted ? `color:var(--rr-text-secondary, #888);font-weight:600;` : `color:${MONEY_ACCENT};font-weight:700;`;
	return `<span style="${style}font-variant-numeric:tabular-nums;">${formatRupees(num)}</span>`;
}

/** Small uppercase mini-header, used above e.g. a packet of text or a
 * grouped list - one definition so every view's "section label" text
 * looks identical. */
export const SECTION_LABEL_STYLE: React.CSSProperties = {
	fontSize: 11,
	fontWeight: 700,
	textTransform: 'uppercase',
	color: 'var(--rr-text-secondary)',
};

export const SUBTLE_TEXT_STYLE: React.CSSProperties = {
	fontSize: 12,
	color: 'var(--rr-text-secondary)',
};

/**
 * Shared "still loading, no data yet" placeholder for a query-backed
 * section - same indeterminate-bar visual language as the Upload flow's
 * processing indicator, so "the app is working" looks identical everywhere
 * instead of a section just rendering blank until data arrives.
 */
export function LoadingState({ label = 'Loading…' }: { label?: string }): React.ReactElement {
	return (
		<div style={{ padding: '4px 0' }}>
			<div style={{ marginBottom: 8, ...SUBTLE_TEXT_STYLE }}>{label}</div>
			<div style={{ position: 'relative', height: 6, borderRadius: 3, overflow: 'hidden', background: 'var(--rr-surface-secondary, rgba(128,128,128,0.15))' }}>
				<div style={{ position: 'absolute', top: 0, height: '100%', background: 'var(--rr-color-brand, #4f46e5)', animation: 'rr-uikit-indeterminate 1.4s ease-in-out infinite' }} />
			</div>
			<style>{`
				@keyframes rr-uikit-indeterminate {
					0% { left: -35%; width: 35%; }
					50% { left: 35%; width: 45%; }
					100% { left: 100%; width: 35%; }
				}
			`}</style>
		</div>
	);
}

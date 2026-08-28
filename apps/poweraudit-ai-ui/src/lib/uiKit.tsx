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
import { Card, ContentHeader, EmptyState } from 'shell';

export type BadgeVariant = 'success' | 'info' | 'warning' | 'error' | 'muted';

/** The one-line answer to "what is this product?", shown persistently in
 * the sidebar so someone opening this cold knows immediately. */
export const PRODUCT_TAGLINE = 'PowerAudit AI finds hidden overcharges in commercial electricity bills.';

/**
 * Plain-English definitions for every domain term this UI shows. Written
 * for someone who has never seen an electricity-demand penalty before -
 * no jargon restated as jargon, and no assumed knowledge of Indian
 * DISCOM tariffs.
 *
 * These are rendered as native `title` tooltips (see {@link Term}) rather
 * than a hand-rolled CSS popup ON PURPOSE: this app relies heavily on
 * `overflow: auto` scroll containers (the meter list, each view body, the
 * draft-packet block), and an absolutely-positioned popup inside any of
 * those gets clipped at the container edge. A native tooltip is painted by
 * the browser outside the document flow, so it can never be clipped - and
 * it works identically inside CardDataGrid's Tabulator formatters, which
 * emit raw HTML strings and cannot host a React component at all.
 */
export const GLOSSARY: Record<string, string> = {
	'Contract Demand':
		'The maximum power draw a site formally agreed to with its electricity utility, measured in kVA. Drawing more than this triggers a penalty charge.',
	'Maximum Demand':
		'The highest level of power a site actually drew at any single point during the billing period, measured in kVA. Compared against Contract Demand to find penalties.',
	'MD penalty': "Charged when a site's peak power draw exceeds the limit it agreed to with the utility.",
	'Power Factor':
		'A score from 0 to 1 for how efficiently a site uses the power it draws. Utilities pay a rebate for a high score and add a surcharge for a low one.',
	'PF penalty':
		'A surcharge for using power inefficiently - drawing more electrical current than the site productively uses. A rebate applies instead when efficiency is high.',
	'Math error': "The bill's own line items do not add up to the total it charges.",
	'Disputed impact':
		'The rupee value of billing errors found - money the site appears to have been overcharged and could claim back from the utility.',
	'Needs review':
		"This bill's figures could not be read with full confidence, so a person should check it before the numbers are trusted.",
	DISCOM: 'Distribution Company - the regional electricity utility that issues the bill.',
	Confidence: 'How certain the system is that it read this bill’s figures correctly, from 0 (a guess) to 1 (fully confident).',
	'Contract impacting': "Resolving this claim would change the site's agreed contract terms with the utility, not just refund money.",
	Claim: 'A formal request to the utility to refund a specific overcharge. Every claim needs a named human approver before it can be filed.',
	Meter: 'A single electricity connection at a site. Bills, penalties, and claims are all tracked per meter.',
};

/** The explanation a first-timer needs the first time they see a grey
 * (negative) rupee figure - grey alone doesn't tell them why. */
export const NEGATIVE_IMPACT_EXPLANATION =
	'Figures shown in grey are negative, meaning the utility undercharged this bill. Those are not disputable - there is nothing to claim back - so only the highlighted positive figures are money the site could actually recover.';

/**
 * An inline domain term carrying its plain-English definition as a hover
 * tooltip, marked with a dotted underline and a small superscript "?" so
 * it's discoverable rather than a hidden affordance.
 */
export function Term({ term, children }: { term: string; children?: React.ReactNode }): React.ReactElement {
	const definition = GLOSSARY[term];
	return (
		<span
			title={definition ?? term}
			style={{ borderBottom: '1px dotted currentColor', cursor: 'help', whiteSpace: 'nowrap' }}
		>
			{children ?? term}
			<span style={{ fontSize: '0.7em', verticalAlign: 'super', marginLeft: 1, opacity: 0.7 }}>?</span>
		</span>
	);
}

/** A standalone "?" help dot carrying an arbitrary explanation - for
 * places where there's no natural word to underline (e.g. beside a
 * section heading). */
export function InfoTip({ text }: { text: string }): React.ReactElement {
	return (
		<span
			title={text}
			style={{
				display: 'inline-flex',
				alignItems: 'center',
				justifyContent: 'center',
				width: 14,
				height: 14,
				borderRadius: '50%',
				border: '1px solid var(--rr-text-secondary)',
				color: 'var(--rr-text-secondary)',
				fontSize: 10,
				fontWeight: 700,
				cursor: 'help',
				marginLeft: 6,
				verticalAlign: 'middle',
			}}
		>
			?
		</span>
	);
}

/**
 * The plain-language "what am I looking at, and why does it matter?"
 * block at the top of every view. Deliberately NOT a shell Banner: a
 * Banner reads as a transient alert, and this is permanent explanatory
 * copy that should look calm rather than urgent.
 */
export function ViewIntro({ children }: { children: React.ReactNode }): React.ReactElement {
	return (
		<div
			style={{
				padding: '12px 14px',
				borderRadius: 8,
				background: 'var(--rr-surface-secondary, rgba(128,128,128,0.08))',
				borderLeft: '3px solid var(--rr-color-brand, #4f46e5)',
				fontSize: 13,
				lineHeight: 1.55,
			}}
		>
			{children}
		</div>
	);
}

/**
 * Identical outer chrome for all four views: same padding, same header
 * placement, same gap rhythm - and, critically, the same scroll model.
 *
 * The scroll model is the fix for a bug class that has now bitten this app
 * twice (Site Drill-down, then Comparisons): the shell's client area does
 * NOT provide page-level scrolling for hosted apps, so a view whose root
 * div simply grows with its content pushes everything past the fold out of
 * reach, with no scrollbar anywhere. The correct shape is a height-bounded
 * outer column (`height: 100%`) holding a fixed header plus a body that is
 * `flex: 1` AND `minHeight: 0` AND `overflowY: auto`. The `minHeight: 0` is
 * the piece that's easy to miss: a flex item defaults to `min-height: auto`,
 * which refuses to shrink below its content, so `overflow` never engages
 * without it. Centralizing this here means no view has to get it right
 * again on its own.
 *
 * `scrollBody={false}` opts out for a view that manages its own internal
 * scroll regions (Site Drill-down's two independently-scrolling columns).
 */
export function ViewShell({
	title,
	subtitle,
	intro,
	actions,
	scrollBody = true,
	children,
}: {
	title: string;
	subtitle?: string;
	intro?: React.ReactNode;
	actions?: React.ReactNode;
	scrollBody?: boolean;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, height: '100%', minHeight: 0, boxSizing: 'border-box' }}>
			<ContentHeader title={title} subtitle={subtitle} actions={actions} />
			<div
				style={{
					flex: 1,
					minHeight: 0,
					display: 'flex',
					flexDirection: 'column',
					gap: 16,
					...(scrollBody ? { overflowY: 'auto' } : {}),
				}}
			>
				{intro && <ViewIntro>{intro}</ViewIntro>}
				{children}
			</div>
		</div>
	);
}

/** Consistent, first-timer-worded empty state wrapped in a Card so it
 * matches the surrounding section rhythm instead of floating bare. */
export function EmptyStateCard({ header, title, description }: { header?: string; title: string; description?: string }): React.ReactElement {
	return (
		<Card header={header}>
			<EmptyState title={title} description={description} />
		</Card>
	);
}

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

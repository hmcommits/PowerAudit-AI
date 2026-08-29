// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * PowerAudit AI — root component rendered by the RocketRide shell.
 *
 * Feature 5: Dashboard, Comparisons & Audit Trail - three read views, all
 * reading live data from RocketRide SQL via the shared foundation-sql
 * pipeline (see src/lib/db.ts) - no mock/hardcoded data anywhere in this app.
 * Plus an interactive Upload view: real bill upload -> bill-ingestion.pipe
 * -> Schema Validate -> recalculation, triggered from the UI (see
 * src/lib/billIngestion.ts).
 */

import React, { useMemo, useState } from 'react';
import type { ShellAppProps } from 'shell';
import { AppLayout, SidebarMenu, useShellEvent } from 'shell';
import { noteTaskEvent, noteUploadProgress } from './lib/uploadStore';
import { PortfolioView } from './views/PortfolioView';
import { DrilldownView } from './views/DrilldownView';
import { ComparisonsView } from './views/ComparisonsView';
import { UploadView } from './views/UploadView';
import { PRODUCT_TAGLINE } from './lib/uiKit';

type ViewId = 'upload' | 'portfolio' | 'drilldown' | 'comparisons';

const MENU = {
	entries: [
		{ id: 'upload', label: 'Upload Bill' },
		{ id: 'portfolio', label: 'Portfolio Summary' },
		{ id: 'drilldown', label: 'Site Drill-down' },
		{ id: 'comparisons', label: 'Comparisons' },
	],
};

const Content: React.FC<{ view: ViewId }> = ({ view }) => {
	if (view === 'upload') return <UploadView />;
	if (view === 'drilldown') return <DrilldownView />;
	if (view === 'comparisons') return <ComparisonsView />;
	return <PortfolioView />;
};

const App: React.FC<ShellAppProps> = () => {
	const [view, setView] = useState<ViewId>('upload');

	// Upload progress is tracked HERE, not in UploadView, because App is
	// always mounted while a view is not. Subscribing in UploadView meant
	// navigating away stopped progress tracking mid-upload (and, with the
	// state also being view-local, lost the whole submission - see
	// lib/uploadStore.ts).
	useShellEvent('shell:event', ({ event }) => {
		const e = event as { event?: string; body?: Record<string, unknown> };
		// apaevt_status_upload drives the byte-progress bar.
		if (e.event === 'apaevt_status_upload') {
			noteUploadProgress((e.body ?? {}) as { action?: string; bytes_sent?: number; file_size?: number });
			return;
		}
		// apaevt_task carries the task lifecycle, including the "end" that
		// says the server finished. This branch did not exist: the handler
		// early-returned on anything that wasn't apaevt_status_upload, so a
		// captured `{"action":"end","name":"bill-ingestion-app.dropper_1"}`
		// reached the browser and was discarded, leaving the UI on
		// "Uploading 100%" indefinitely.
		if (e.event === 'apaevt_task') {
			noteTaskEvent((e.body ?? {}) as { action?: string; name?: string; source?: string });
		}
	});

	// Stable node - the shell dedupes sidebar registrations by node identity.
	// The tagline sits below the menu (pushed down by marginTop:auto) so the
	// "what is this product?" answer is on screen in every view, not just on
	// whichever one the user happens to open first.
	const sidebar = useMemo(
		() => (
			<div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
				{/* SidebarMenu takes menu/activeId/onSelect/sectionLabel/collapsed
				    only - no style or size prop (its rows are fixed inline styles
				    with no className hook, same as DropZone) - so `zoom` is the
				    lever for bigger, more prominent tabs. Kept modest (1.2x, not
				    the 2.2x used on the dropzone) because AppLayout owns the
				    sidebar's width (~260px, not ours to resize) and zoom scales an
				    item's rendered width along with its text - too high a factor
				    risks the longer labels ("Portfolio Summary", "Site Drill-down")
				    wrapping or clipping inside that fixed column. The tagline below
				    is deliberately OUTSIDE the zoomed wrapper, unchanged. */}
				<div style={{ zoom: 1.2 } as React.CSSProperties}>
					<SidebarMenu menu={MENU} activeId={view} onSelect={(id) => setView(id as ViewId)} sectionLabel="PowerAudit AI" />
				</div>
				<div style={{ marginTop: 'auto', padding: '12px 12px 4px', fontSize: 11, lineHeight: 1.5, color: 'var(--rr-text-secondary)' }}>{PRODUCT_TAGLINE}</div>
			</div>
		),
		[view],
	);

	return (
		<AppLayout sidebar={sidebar} showStatus>
			<Content view={view} />
		</AppLayout>
	);
};

export default App;

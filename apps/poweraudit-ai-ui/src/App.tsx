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
import { AppLayout, SidebarMenu } from 'shell';
import { PortfolioView } from './views/PortfolioView';
import { DrilldownView } from './views/DrilldownView';
import { ComparisonsView } from './views/ComparisonsView';
import { UploadView } from './views/UploadView';

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

	// Stable node - the shell dedupes sidebar registrations by node identity.
	const sidebar = useMemo(
		() => <SidebarMenu menu={MENU} activeId={view} onSelect={(id) => setView(id as ViewId)} sectionLabel="PowerAudit AI" />,
		[view],
	);

	return (
		<AppLayout sidebar={sidebar} showStatus>
			<Content view={view} />
		</AppLayout>
	);
};

export default App;

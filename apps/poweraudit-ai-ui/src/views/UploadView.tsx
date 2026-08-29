// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import React, { useCallback } from 'react';
import { Banner, Button, Card, ContentHeader, DropZone, useShellConnection } from 'shell';
import type { IngestResult, IngestStatus } from '../lib/billIngestion';
import billIngestionPipe from '../../../../pipelines/bill-ingestion.pipe';
import { resetUpload, startUpload, useUploadState } from '../lib/uploadStore';
import { FindingTypeBadge, MoneyValue, SECTION_LABEL_STYLE, SUBTLE_TEXT_STYLE } from '../lib/uiKit';

/**
 * Pure view over the app-level upload store (../lib/uploadStore.ts). This
 * component deliberately holds NO upload state of its own: it used to, and
 * navigating to another tab mid-upload unmounted it and silently discarded
 * the in-flight submission. Reading from the store means a remount picks
 * the upload back up exactly where it is - including one that finished
 * while the user was looking at a different view.
 */
export const UploadView: React.FC = () => {
	const { client, isConnected } = useShellConnection();
	const { stage, progressPct, result, errorMsg, fileName, slow, serverFinished, attempt, maxAttempts } = useUploadState();

	const handleFiles = useCallback(
		(files: FileList) => {
			if (!client) return;
			const file = files[0];
			if (!file) return;
			// Not awaited on purpose - the store owns this promise's lifetime,
			// so it runs to completion whether or not this view stays mounted.
			void startUpload(client, file, billIngestionPipe);
		},
		[client],
	);

	// Which pipeline step is live right now, so the explainer on the right
	// doubles as a progress indicator instead of being static decoration.
	const activeStep = stage === 'uploading' ? 0 : stage === 'processing' ? 2 : stage === 'done' ? 4 : -1;

	return (
		<div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, height: '100%', minHeight: 0, boxSizing: 'border-box' }}>
			<ContentHeader
				title="Upload Bill"
				subtitle="Drop a scanned or photographed electricity bill (PDF or photo) to ingest, validate, and recalculate it live - the same pipeline scripts/ingest_bills.py runs, triggered from here instead of a terminal."
			/>

			<div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0, alignItems: 'flex-start', flexWrap: 'wrap' }}>
				<div style={{ flex: '1 1 460px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760 }}>
				{stage === 'idle' && (
					<Card>
						{/* DropZone takes only title/hint/onFiles - no style or size
						    prop (checked its source: fixed inline styles, no
						    className hook) - so `zoom` is the one lever that scales
						    its "+" icon, text, and padding together without reaching
						    into shell internals. minHeight centers it at a size that
						    reads as a large, obvious target next to the pipeline
						    explainer beside it. */}
						<div style={{ minHeight: 380, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
							<div style={{ zoom: 2.2, width: '100%', maxWidth: 420 } as React.CSSProperties}>
								<DropZone title="Drop a bill here to ingest" hint="Supports PDF, JPG, PNG" onFiles={handleFiles} />
							</div>
						</div>
						{!isConnected && <Banner variant="warning">Not connected - reconnect before uploading.</Banner>}
					</Card>
				)}

				{(stage === 'uploading' || stage === 'processing') && (
					<Card header={fileName ? `Processing ${fileName}…` : 'Processing…'}>
						<ProcessingIndicator stage={stage} progressPct={progressPct} />
						<div style={{ marginTop: 10, ...SUBTLE_TEXT_STYLE }}>
							You can switch to another tab while this runs - it keeps processing in the background, and the result will still be here when you come back.
						</div>
						{attempt > 1 && (
							<div style={{ marginTop: 12 }}>
								<Banner variant="warning">
									The connection dropped partway through - this happens occasionally and isn’t something you did. Automatically retrying (attempt{' '}
									{attempt} of {maxAttempts})…
								</Banner>
							</div>
						)}
						{serverFinished && (
							<div style={{ marginTop: 12 }}>
								<Banner variant="info">The server has finished reading this bill and the result is on its way.</Banner>
							</div>
						)}
						{slow && !serverFinished && (
							<div style={{ marginTop: 12 }}>
								<Banner variant="warning">
									This is taking longer than usual. Reading a bill normally finishes in about two minutes — it may still complete on its own. If it
									doesn’t, you’ll get a clear message rather than an endless spinner, and re-uploading the same file is always safe.
								</Banner>
							</div>
						)}
					</Card>
				)}

				{stage === 'done' && (
					<div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
						{errorMsg && <Banner variant="error">Unexpected error: {errorMsg}</Banner>}
						{result && <ResultCard result={result} />}
						<Button onClick={resetUpload}>Upload another bill</Button>
				</div>
			)}
				</div>
				<div style={{ flex: '1 1 320px', minWidth: 280, maxWidth: 420 }}>
					<PipelineExplainer activeStep={activeStep} />
				</div>
			</div>
		</div>
	);
};

interface PipelineStep {
	title: string;
	detail: string;
}

/** The five stages a dropped bill actually goes through. Written for someone
 * who has never seen the pipeline - it answers "what is it doing right now?"
 * during the ~20s-2min wait, and fills what was otherwise dead space to the
 * right of the dropzone. */
const PIPELINE_STEPS: PipelineStep[] = [
	{ title: 'Your bill', detail: 'A PDF or a phone photo, exactly as the utility issued it. Nothing needs to be typed in by hand.' },
	{ title: 'Reading the page', detail: 'RocketRide cleans up the image and runs OCR, so even a skewed, low-light photo becomes machine-readable text.' },
	{ title: 'Pulling out the numbers', detail: 'An AI extraction step finds the meter number, billing period, agreed limit, peak demand, power factor, line items and total.' },
	{ title: 'Checking the maths', detail: 'Plain, auditable code — no AI — recalculates the penalties against the tariff rules and compares them to what you were charged.' },
	{ title: 'What we found', detail: 'Any discrepancy is saved as a finding with its rupee value, ready to review and turn into a refund claim.' },
];

function PipelineExplainer({ activeStep }: { activeStep: number }): React.ReactElement {
	return (
		<Card header="What happens to your bill">
			<div style={{ ...SUBTLE_TEXT_STYLE, marginBottom: 14 }}>
				Five steps run on RocketRide each time you drop a file in. {activeStep >= 0 ? 'The highlighted step is roughly where it is now.' : 'Nothing is running yet.'}
			</div>
			<div style={{ display: 'flex', flexDirection: 'column' }}>
				{PIPELINE_STEPS.map((step, i) => {
					const isActive = activeStep >= 0 && i <= activeStep;
					const isCurrent = i === activeStep;
					return (
						<div key={step.title} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
							<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', alignSelf: 'stretch' }}>
								<div
									style={{
										width: 22,
										height: 22,
										borderRadius: '50%',
										flexShrink: 0,
										display: 'flex',
										alignItems: 'center',
										justifyContent: 'center',
										fontSize: 11,
										fontWeight: 700,
										background: isActive ? 'var(--rr-color-brand, #4f46e5)' : 'var(--rr-surface-secondary, rgba(128,128,128,0.18))',
										color: isActive ? '#fff' : 'var(--rr-text-secondary)',
										border: isCurrent ? '2px solid var(--rr-color-brand, #4f46e5)' : undefined,
									}}
								>
									{i + 1}
								</div>
								{i < PIPELINE_STEPS.length - 1 && (
									<div style={{ width: 2, flex: 1, minHeight: 18, background: isActive ? 'var(--rr-color-brand, #4f46e5)' : 'var(--rr-border-color, rgba(128,128,128,0.25))' }} />
								)}
							</div>
							<div style={{ paddingBottom: 14 }}>
								<div style={{ fontWeight: 600, fontSize: 13 }}>{step.title}</div>
								<div style={{ ...SUBTLE_TEXT_STYLE, marginTop: 2, lineHeight: 1.5 }}>{step.detail}</div>
							</div>
						</div>
					);
				})}
			</div>
		</Card>
	);
}

function ProcessingIndicator({ stage, progressPct }: { stage: 'uploading' | 'processing'; progressPct: number }): React.ReactElement {
	return (
		<div>
			<style>{`
				@keyframes rr-indeterminate {
					0% { left: -35%; width: 35%; }
					50% { left: 35%; width: 45%; }
					100% { left: 100%; width: 35%; }
				}
			`}</style>
			<div style={{ marginBottom: 8, fontSize: 13, color: 'var(--rr-text-secondary)' }}>
				{stage === 'uploading' ? `Uploading... ${progressPct}%` : 'Running OCR & AI extraction - this can take up to 30 seconds. Not frozen, just working.'}
			</div>
			<div style={{ position: 'relative', height: 8, borderRadius: 4, overflow: 'hidden', background: 'var(--rr-surface-secondary, rgba(128,128,128,0.15))' }}>
				{stage === 'uploading' ? (
					<div style={{ position: 'absolute', top: 0, left: 0, height: '100%', width: `${progressPct}%`, background: 'var(--rr-color-brand, #4f46e5)', transition: 'width 150ms ease' }} />
				) : (
					<div style={{ position: 'absolute', top: 0, height: '100%', background: 'var(--rr-color-brand, #4f46e5)', animation: 'rr-indeterminate 1.4s ease-in-out infinite' }} />
				)}
			</div>
		</div>
	);
}

const STATUS_TITLE: Record<IngestStatus, string> = {
	OK: 'Ingested successfully',
	NEEDS_REVIEW: 'Ingested - flagged for review',
	REJECTED: "Rejected - couldn't ingest",
	ERROR: 'Pipeline error',
	TIMEOUT: "No response from the server - here's exactly where that leaves you",
};

const STATUS_VARIANT: Record<IngestStatus, 'info' | 'warning' | 'error'> = {
	OK: 'info',
	NEEDS_REVIEW: 'warning',
	REJECTED: 'error',
	ERROR: 'error',
	TIMEOUT: 'warning',
};

function ResultCard({ result }: { result: IngestResult }): React.ReactElement {
	return (
		<Card header={STATUS_TITLE[result.status]}>
			<Banner variant={STATUS_VARIANT[result.status]}>
				<strong>{result.fileName}</strong>
				{result.billId && (
					<>
						{' '}
						— bill_id: <code>{result.billId}</code>
					</>
				)}
				{result.meterId && <> (meter {result.meterId})</>}
			</Banner>

			{result.reasons.length > 0 && (
				<div style={{ marginTop: 12 }}>
					<div style={{ ...SECTION_LABEL_STYLE, marginBottom: 4 }}>{result.status === 'REJECTED' || result.status === 'ERROR' ? 'Reasons' : 'Flags'}</div>
					<ul style={{ margin: 0, paddingLeft: 20 }}>
						{result.reasons.map((r, i) => (
							<li key={i} style={{ fontSize: 13 }}>
								{r}
							</li>
						))}
					</ul>
				</div>
			)}

			{result.findings && result.findings.length > 0 && (
				<div style={{ marginTop: 16 }}>
					<div style={{ ...SECTION_LABEL_STYLE, marginBottom: 4 }}>Findings ({result.findings.length})</div>
					{result.findings.map((f, i) => (
						<div
							key={i}
							style={{
								padding: '10px 0',
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'space-between',
								gap: 12,
								borderTop: i > 0 ? '1px solid var(--rr-border-color, rgba(128,128,128,0.2))' : undefined,
							}}
						>
							<div>
								<FindingTypeBadge type={f.type} />
								<div style={{ marginTop: 4, ...SUBTLE_TEXT_STYLE }}>
									{f.detail} · confidence {f.confidence}
								</div>
							</div>
							<MoneyValue value={f.rupeeImpact} size="lg" mutedIfNonPositive />
						</div>
					))}
				</div>
			)}

			{result.findings && result.findings.length === 0 && result.billId && (
				<div style={{ marginTop: 12, fontSize: 13, color: 'var(--rr-text-secondary)' }}>No discrepancies found - this bill recalculates cleanly.</div>
			)}

			{result.billId && (
				<div style={{ marginTop: 16, fontSize: 12, color: 'var(--rr-text-secondary)' }}>
					Check the Site Drill-down and Portfolio Summary tabs to see this reflected — no reload needed, they refetch live from RocketRide SQL.
				</div>
			)}
		</Card>
	);
}

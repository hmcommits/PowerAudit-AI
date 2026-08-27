// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import React, { useCallback, useState } from 'react';
import { Banner, Button, Card, ContentHeader, DropZone, useShellConnection, useShellEvent } from 'shell';
import { ingestBill } from '../lib/billIngestion';
import type { IngestResult, IngestStatus } from '../lib/billIngestion';
import billIngestionPipe from '../../../../pipelines/bill-ingestion.pipe';

type Stage = 'idle' | 'uploading' | 'processing' | 'done';

interface UploadEventBody {
	action?: string;
	bytes_sent?: number;
	file_size?: number;
}

export const UploadView: React.FC = () => {
	const { client, isConnected } = useShellConnection();
	const [stage, setStage] = useState<Stage>('idle');
	const [progressPct, setProgressPct] = useState(0);
	const [result, setResult] = useState<IngestResult | null>(null);
	const [errorMsg, setErrorMsg] = useState<string | null>(null);

	useShellEvent('shell:event', ({ event }) => {
		const e = event as { event?: string; body?: UploadEventBody };
		if (e.event !== 'apaevt_status_upload') return;
		setStage((current) => {
			if (current !== 'uploading') return current;
			const { bytes_sent, file_size, action } = e.body ?? {};
			if (file_size) setProgressPct(Math.round(((bytes_sent ?? 0) / file_size) * 100));
			return action === 'complete' ? 'processing' : current;
		});
	});

	const handleFiles = useCallback(
		async (files: FileList) => {
			if (!client) return;
			const file = files[0];
			if (!file) return;
			setResult(null);
			setErrorMsg(null);
			setProgressPct(0);
			setStage('uploading');
			try {
				const outcome = await ingestBill(client, file, billIngestionPipe);
				setResult(outcome);
			} catch (e) {
				setErrorMsg(e instanceof Error ? e.message : String(e));
			} finally {
				setStage('done');
			}
		},
		[client],
	);

	const reset = () => {
		setStage('idle');
		setResult(null);
		setErrorMsg(null);
		setProgressPct(0);
	};

	return (
		<div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760 }}>
			<ContentHeader
				title="Upload Bill"
				subtitle="Drop a scanned or photographed electricity bill (PDF or photo) to ingest, validate, and recalculate it live - the same pipeline scripts/ingest_bills.py runs, triggered from here instead of a terminal."
			/>

			{stage === 'idle' && (
				<Card>
					<DropZone title="Drop a bill here to ingest" hint="Supports PDF, JPG, PNG" onFiles={handleFiles} />
					{!isConnected && <Banner variant="warning">Not connected - reconnect before uploading.</Banner>}
				</Card>
			)}

			{(stage === 'uploading' || stage === 'processing') && (
				<Card header="Processing...">
					<ProcessingIndicator stage={stage} progressPct={progressPct} />
				</Card>
			)}

			{stage === 'done' && (
				<div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
					{errorMsg && <Banner variant="error">Unexpected error: {errorMsg}</Banner>}
					{result && <ResultCard result={result} />}
					<Button onClick={reset}>Upload another bill</Button>
				</div>
			)}
		</div>
	);
};

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
};

const STATUS_VARIANT: Record<IngestStatus, 'info' | 'warning' | 'error'> = {
	OK: 'info',
	NEEDS_REVIEW: 'warning',
	REJECTED: 'error',
	ERROR: 'error',
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
					<div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: 'var(--rr-text-secondary)', marginBottom: 4 }}>
						{result.status === 'REJECTED' || result.status === 'ERROR' ? 'Reasons' : 'Flags'}
					</div>
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
					<div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: 'var(--rr-text-secondary)', marginBottom: 4 }}>Findings ({result.findings.length})</div>
					{result.findings.map((f, i) => (
						<div key={i} style={{ padding: '8px 0', borderTop: i > 0 ? '1px solid var(--rr-border-color, rgba(128,128,128,0.2))' : undefined }}>
							<strong>{f.type}</strong>: Rs. {f.rupeeImpact.toLocaleString('en-IN')} (confidence {f.confidence})
							<div style={{ fontSize: 12, color: 'var(--rr-text-secondary)' }}>{f.detail}</div>
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

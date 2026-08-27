import { useState, useRef, useCallback } from 'react'
import { Play, ClipboardList, Upload, Search, FileText, X, CheckCircle, AlertCircle } from 'lucide-react'
import { api, fmt } from '../api'
import Badge from '../components/Badge'

// Shared result card
function ResultCard({ result }) {
  const p2 = result?.penalty_detection || {}
  const overcharged = (p2.findings || []).filter(f => f.variance_flag === 'OVERCHARGED')

  return (
    <div className="mt-5 bg-white border border-gray-200 shadow-sm rounded-lg overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-200 flex items-center gap-2">
        <CheckCircle size={16} className="text-green-500" />
        <span className="text-sm font-bold text-gray-900">
          Bill {result.bill_id} processed
        </span>
        {result.needs_review && (
          <span className="ml-auto text-xs font-semibold text-orange-600 bg-orange-50 border border-orange-200 px-2 py-0.5 rounded-full">
            ⚠ Needs Review
          </span>
        )}
      </div>

      <div className="p-5 grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Rupee Impact',  value: fmt.inr(p2.total_rupee_impact), color: (p2.total_rupee_impact || 0) > 0 ? 'text-red-600' : 'text-green-600' },
          { label: 'Confidence',   value: `${p2.confidence_score || 0}%`,  color: 'text-gray-900' },
          { label: 'Findings',     value: p2.findings_count ?? (p2.findings?.length ?? 0), color: 'text-blue-600' },
          { label: 'Material',     value: p2.materiality_flag ? '⚠ YES' : 'NO', color: p2.materiality_flag ? 'text-red-600' : 'text-gray-400' },
        ].map(m => (
          <div key={m.label}>
            <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide mb-1">{m.label}</p>
            <p className={`text-xl font-extrabold ${m.color}`}>{m.value}</p>
          </div>
        ))}
      </div>

      {overcharged.length > 0 && (
        <div className="px-5 pb-5 space-y-2">
          {overcharged.map(f => (
            <div key={f.finding_id} className="bg-red-50 border border-red-100 rounded-lg p-3 text-xs">
              <p className="font-bold text-red-700 mb-1">{f.finding_type} — OVERCHARGED</p>
              <p className="text-red-600">
                Billed {fmt.inr(f.billed_amount)} → Should be {fmt.inr(f.recalculated_amount)} →{' '}
                <strong>Impact {fmt.inr(f.rupee_impact)}</strong>
              </p>
              <p className="text-red-400 mt-1">📎 {f.citation_clause_ref || 'No citation'}</p>
            </div>
          ))}
        </div>
      )}

      {result.quality_notes && (
        <div className="px-5 pb-4">
          <p className="text-[10px] text-gray-400">🔬 {result.quality_notes}</p>
        </div>
      )}
    </div>
  )
}

// Preset JSON data
const PRESETS = [
  {
    label: 'MSEDCL',
    data: { bill_id:'B1001',site_id:'S101',month:'Jan',discom_id:'MSEDCL',meter_number:'MH-GGN-001',tariff_category:'HT-I',contract_demand_kva:500,recorded_max_demand_kva:580,power_factor:0.86,units_consumed_kwh:800,energy_charges:6400,md_penalty_billed:45000,pf_penalty_billed:1200,fixed_charges:3000,taxes_and_duties:500,total_due:56100,amount_paid:6400,outstanding_amount:49700,payment_status:'Overdue',provider_name:'Tata Power' },
  },
  {
    label: 'TSSPDCL',
    data: { bill_id:'B2001',site_id:'S106',month:'Jan',discom_id:'TSSPDCL',meter_number:'TS-HYD-006',tariff_category:'HT-II',contract_demand_kva:400,recorded_max_demand_kva:410,power_factor:0.96,units_consumed_kwh:850,energy_charges:6800,md_penalty_billed:0,pf_penalty_billed:0,fixed_charges:2500,taxes_and_duties:420,total_due:9720,amount_paid:0,outstanding_amount:9720,payment_status:'Overdue',provider_name:'NTPC Utility' },
  },
  {
    label: 'BESCOM',
    data: { bill_id:'B3001',site_id:'S105',month:'Feb',discom_id:'BESCOM',meter_number:'KA-BLR-005',tariff_category:'HT-2(a)',contract_demand_kva:600,recorded_max_demand_kva:290,power_factor:0.90,units_consumed_kwh:700,energy_charges:5600,md_penalty_billed:0,pf_penalty_billed:0,fixed_charges:2800,taxes_and_duties:380,total_due:8780,amount_paid:5600,outstanding_amount:3180,payment_status:'Pending',provider_name:'CESC Limited' },
  },
]

//  TAB 1 — JSON input (existing)
function JsonTab() {
  const [json, setJson]       = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult]   = useState(null)
  const [error, setError]     = useState(null)

  const ingest = async () => {
    setError(null); setResult(null)
    let body
    try { body = JSON.parse(json) } catch (e) { setError('JSON parse error: ' + e.message); return }
    setLoading(true)
    try {
      const data = await api.ingestBill(body)
      if (data.error) setError(data.error)
      else setResult(data)
    } catch (e) { setError('Network error: ' + e.message) }
    setLoading(false)
  }

  return (
    <div>
      {/* Presets */}
      <div className="flex gap-2 mb-4 flex-wrap">
        {PRESETS.map(p => (
          <button
            key={p.label}
            onClick={() => { setJson(JSON.stringify(p.data, null, 2)); setResult(null); setError(null) }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            <ClipboardList size={12} />
            {p.label} Fixture
          </button>
        ))}
      </div>

      {/* Textarea */}
      <div className="bg-white border border-gray-200 shadow-sm rounded-lg overflow-hidden mb-4">
        <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
          <span className="text-xs font-bold text-gray-500 uppercase tracking-wide">Bill JSON</span>
          {json && (
            <button onClick={() => setJson('')} className="text-gray-400 hover:text-gray-600 transition-colors">
              <X size={12} />
            </button>
          )}
        </div>
        <textarea
          value={json}
          onChange={e => setJson(e.target.value)}
          rows={14}
          placeholder='Paste bill JSON here or click a preset above...'
          className="w-full p-4 font-mono text-xs text-gray-800 bg-white outline-none resize-y"
        />
      </div>

      <button
        onClick={ingest}
        disabled={loading || !json.trim()}
        className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        <Play size={14} />
        {loading ? 'Analysing…' : 'Ingest & Analyse'}
      </button>

      {error  && <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">{error}</div>}
      {result && <ResultCard result={result} />}
    </div>
  )
}

//  TAB 2 — PDF / image upload
const ACCEPTED = '.pdf,.jpg,.jpeg,.png,.tiff,.tif,.webp,.bmp'

function PdfTab() {
  const [file, setFile]       = useState(null)
  const [dragging, setDragging] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult]   = useState(null)
  const [error, setError]     = useState(null)
  const inputRef = useRef(null)

  const accept = (f) => {
    setFile(f); setResult(null); setError(null)
  }

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) accept(f)
  }, [])

  const upload = async () => {
    setError(null); setResult(null); setLoading(true)
    try {
      const data = await api.uploadBill(file)
      if (data.error) setError(data.error)
      else setResult(data)
    } catch (e) { setError('Network error: ' + e.message) }
    setLoading(false)
  }

  const fileIconFor = (f) => {
    if (!f) return '📄'
    if (f.type === 'application/pdf') return '📑'
    if (f.type.startsWith('image/')) return '🖼️'
    return '📄'
  }

  return (
    <div>
      <p className="text-xs text-gray-500 mb-4">
        Supports <strong>PDF</strong>, JPG, PNG, TIFF, WEBP. The cleanup node deskews and denoises images before OCR.
      </p>

      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={`relative flex flex-col items-center justify-center gap-3 p-10 border-2 border-dashed rounded-xl cursor-pointer transition-all
          ${dragging ? 'border-blue-400 bg-blue-50' : 'border-gray-300 bg-gray-50 hover:border-blue-300 hover:bg-blue-50/40'}
        `}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED}
          className="hidden"
          onChange={e => e.target.files[0] && accept(e.target.files[0])}
        />

        {file ? (
          <>
            <span className="text-4xl">{fileIconFor(file)}</span>
            <div className="text-center">
              <p className="text-sm font-semibold text-gray-900">{file.name}</p>
              <p className="text-xs text-gray-400 mt-0.5">{(file.size / 1024).toFixed(1)} KB</p>
            </div>
            <button
              onClick={e => { e.stopPropagation(); setFile(null); setResult(null); setError(null) }}
              className="flex items-center gap-1 px-3 py-1 text-xs text-gray-500 border border-gray-200 rounded-lg hover:bg-white transition-colors"
            >
              <X size={11} /> Remove
            </button>
          </>
        ) : (
          <>
            <div className="w-12 h-12 rounded-xl bg-white border border-gray-200 shadow-sm flex items-center justify-center">
              <Upload size={22} className="text-gray-400" />
            </div>
            <div className="text-center">
              <p className="text-sm font-semibold text-gray-700">
                Drop your bill here, or <span className="text-blue-600">browse</span>
              </p>
              <p className="text-xs text-gray-400 mt-1">PDF, JPG, PNG, TIFF, WEBP — max 20 MB</p>
            </div>
          </>
        )}
      </div>

      {/* Upload button */}
      <div className="mt-4">
        <button
          onClick={upload}
          disabled={!file || loading}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Upload size={14} />
          {loading ? 'Processing…' : 'Upload & Analyse'}
        </button>
        {loading && (
          <p className="mt-2 text-xs text-gray-400">
            Running cleanup → OCR → extraction → schema validate…
          </p>
        )}
      </div>

      {error && <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">{error}</div>}
      {result && <ResultCard result={result} />}
    </div>
  )
}

//  TAB 3 — Consumer number lookup
function ConsumerTab() {
  const [consumerNo, setConsumerNo] = useState('')
  const [loading, setLoading]       = useState(false)
  const [lookupResult, setLookupResult] = useState(null)
  const [error, setError]           = useState(null)
  const [running, setRunning]       = useState(false)
  const [analysisResult, setAnalysisResult] = useState(null)

  const lookup = async () => {
    if (!consumerNo.trim()) return
    setError(null); setLookupResult(null); setAnalysisResult(null); setLoading(true)
    try {
      const data = await api.lookupConsumer(consumerNo.trim())
      if (data.error) setError(data.error)
      else setLookupResult(data)
    } catch (e) { setError('Network error: ' + e.message) }
    setLoading(false)
  }

  const runAnalysis = async (bill) => {
    setRunning(true); setAnalysisResult(null)
    try {
      // Ingest + analyse the found bill
      const data = await api.ingestBill({ ...bill, bill_id: bill.bill_id })
      if (data.error) setError(data.error)
      else setAnalysisResult(data)
    } catch (e) { setError('Network error: ' + e.message) }
    setRunning(false)
  }

  const bill = lookupResult?.latest_bill
  const findings = lookupResult?.findings || []
  const allBills = lookupResult?.bills || []

  return (
    <div>
      <p className="text-xs text-gray-500 mb-4">
        Enter a <strong>consumer / meter number</strong> to pull the latest bill from the database and re-run the audit pipeline.
      </p>

      {/* Search bar */}
      <div className="flex gap-2 mb-6">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={consumerNo}
            onChange={e => setConsumerNo(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && lookup()}
            placeholder="e.g. MH-GGN-001 or TS-HYD-006"
            className="w-full pl-9 pr-4 py-2.5 text-sm border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-300 focus:border-blue-300 transition bg-white"
          />
        </div>
        <button
          onClick={lookup}
          disabled={!consumerNo.trim() || loading}
          className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Search size={14} />
          {loading ? 'Searching…' : 'Look Up'}
        </button>
      </div>

      {/* Demo hint */}
      <div className="flex flex-wrap gap-2 mb-4">
        <p className="text-[11px] text-gray-400 self-center">Try:</p>
        {['MH-GGN-001', 'TS-HYD-006', 'KA-BLR-005'].map(n => (
          <button
            key={n}
            onClick={() => { setConsumerNo(n); setLookupResult(null); setAnalysisResult(null) }}
            className="text-[11px] font-mono text-blue-600 bg-blue-50 border border-blue-100 px-2 py-0.5 rounded hover:bg-blue-100 transition-colors"
          >
            {n}
          </button>
        ))}
        <p className="text-[11px] text-gray-400 self-center">(run a batch first if DB is empty)</p>
      </div>

      {error && <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600 mb-4">{error}</div>}

      {/* Not found */}
      {lookupResult && !lookupResult.found && (
        <div className="flex flex-col items-center py-10 text-center">
          <AlertCircle size={32} className="text-orange-400 mb-3" />
          <p className="text-sm font-semibold text-gray-700">No bills found for "{consumerNo}"</p>
          <p className="text-xs text-gray-400 mt-1">Run a batch or ingest a bill with this meter number first.</p>
        </div>
      )}

      {/* Found */}
      {lookupResult?.found && bill && !analysisResult && (
        <div className="bg-white border border-gray-200 shadow-sm rounded-lg overflow-hidden">
          {/* Header */}
          <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
            <div>
              <p className="text-sm font-bold text-gray-900">
                <FileText size={14} className="inline mr-1.5 text-blue-500" />
                {bill.meter_number}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                {bill.provider_name || bill.discom_id} · {bill.tariff_category} · {bill.month}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge label={bill.discom_id} variant="blue" />
              {bill.needs_review
                ? <Badge label="⚠ Review" variant="orange" />
                : <Badge label="✓ OK" variant="green" />}
            </div>
          </div>

          {/* Key metrics grid */}
          <div className="px-5 py-4 grid grid-cols-2 sm:grid-cols-4 gap-4 border-b border-gray-100">
            {[
              { label: 'Contract Demand', value: `${bill.contract_demand_kva ?? '—'} kVA` },
              { label: 'Max Demand',      value: `${bill.recorded_max_demand_kva ?? '—'} kVA` },
              { label: 'Power Factor',    value: bill.power_factor ?? '—' },
              { label: 'Total Due',       value: fmt.inr(bill.total_due) },
            ].map(m => (
              <div key={m.label}>
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wide mb-0.5">{m.label}</p>
                <p className="text-sm font-bold text-gray-900">{m.value}</p>
              </div>
            ))}
          </div>

          {/* Existing findings (if any) */}
          {findings.length > 0 && (
            <div className="px-5 py-3 border-b border-gray-100">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">Existing Findings</p>
              <div className="space-y-1.5">
                {findings.map(f => (
                  <div key={f.finding_id} className="flex items-center gap-3 text-xs">
                    <Badge label={f.finding_type} variant={f.finding_type} />
                    <Badge label={f.variance_flag} variant={f.variance_flag} />
                    <span className={`font-bold ${(f.rupee_impact || 0) > 0 ? 'text-red-600' : 'text-green-600'}`}>
                      {fmt.inr(f.rupee_impact)}
                    </span>
                    <span className="text-gray-400 truncate">{f.citation_clause_ref}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* History */}
          {allBills.length > 1 && (
            <div className="px-5 py-3 border-b border-gray-100">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">
                Bill History ({allBills.length} records)
              </p>
              <div className="flex flex-wrap gap-2">
                {allBills.map(b => (
                  <span key={b.bill_id} className="text-[11px] font-mono text-gray-500 bg-gray-50 border border-gray-200 px-2 py-0.5 rounded">
                    {b.month} — {fmt.inr(b.total_due)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="px-5 py-4 flex gap-3">
            <button
              onClick={() => runAnalysis(bill)}
              disabled={running}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              <Play size={14} />
              {running ? 'Running…' : 'Re-run Audit Pipeline'}
            </button>
          </div>
        </div>
      )}

      {analysisResult && <ResultCard result={analysisResult} />}
    </div>
  )
}

//  Main IngestBill — tabs
const TABS = [
  { id: 'json',     label: 'JSON Input',       icon: ClipboardList },
  { id: 'pdf',      label: 'Upload PDF / Image', icon: Upload },
  { id: 'consumer', label: 'Consumer Number',   icon: Search },
]

export default function IngestBill() {
  const [tab, setTab] = useState('json')

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-extrabold text-gray-900 mb-1">Ingest Bill</h1>
      <p className="text-sm text-gray-500 mb-6">Three ways to bring a bill into PowerAudit AI</p>

      {/* Tab bar */}
      <div className="flex gap-1 p-1 bg-gray-100 rounded-xl mb-6">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-sm font-semibold rounded-lg transition-all
              ${tab === id
                ? 'bg-white text-blue-600 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
              }`}
          >
            <Icon size={14} />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      {tab === 'json'     && <JsonTab />}
      {tab === 'pdf'      && <PdfTab />}
      {tab === 'consumer' && <ConsumerTab />}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { RefreshCw, ChevronRight, X, Save } from 'lucide-react'
import { api, fmt } from '../api'
import Badge from '../components/Badge'
import EmptyState from '../components/EmptyState'

const EDITABLE = [
  { key: 'meter_number',          label: 'Meter Number',          type: 'text' },
  { key: 'tariff_category',       label: 'Tariff Category',       type: 'text' },
  { key: 'discom_id',             label: 'DISCOM',                type: 'text' },
  { key: 'contract_demand_kva',   label: 'Contract Demand (kVA)', type: 'number' },
  { key: 'recorded_max_demand_kva', label: 'Max Demand (kVA)',    type: 'number' },
  { key: 'power_factor',          label: 'Power Factor',          type: 'number' },
  { key: 'energy_charges',        label: 'Energy Charges (₹)',    type: 'number' },
  { key: 'total_due',             label: 'Total Due (₹)',         type: 'number' },
]

function ReviewPanel({ bill, onClose, onSaved }) {
  const [form, setForm]     = useState({})
  const [saving, setSaving] = useState(false)
  const [done, setDone]     = useState(false)

  useEffect(() => {
    const init = {}
    EDITABLE.forEach(f => { init[f.key] = bill[f.key] ?? '' })
    setForm(init)
  }, [bill])

  const save = async () => {
    setSaving(true)
    const updates = {}
    EDITABLE.forEach(f => {
      const v = form[f.key]
      if (v !== '' && v != null) updates[f.key] = f.type === 'number' ? parseFloat(v) : v
    })
    await api.submitReview(bill.bill_id, updates)
    setSaving(false)
    setDone(true)
    setTimeout(() => onSaved(), 800)
  }

  const reviewFlags = (() => {
    try { return JSON.parse(bill.review_flags || '{}') } catch { return {} }
  })()

  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-start justify-center pt-8 px-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-5xl mb-8">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div>
            <h2 className="text-base font-bold text-gray-900">Review: {bill.bill_id}</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              {bill.source_file || 'Manual entry'} · {bill.source_type || 'json'}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg transition-colors">
            <X size={18} className="text-gray-500" />
          </button>
        </div>

        {/* Flags */}
        {Object.keys(reviewFlags).length > 0 && (
          <div className="px-6 pt-4 pb-2 flex flex-wrap gap-2">
            {Object.entries(reviewFlags).map(([k, v]) => (
              <span key={k} className="inline-flex items-center gap-1 px-2.5 py-1 bg-orange-50 border border-orange-200 rounded-full text-xs font-medium text-orange-600">
                ⚠ <strong>{k}:</strong> {v}
              </span>
            ))}
          </div>
        )}

        {/* Side-by-side */}
        <div className="grid grid-cols-2 gap-0 divide-x divide-gray-200">
          {/* Left: OCR raw text */}
          <div className="p-5">
            <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">Original OCR Text</p>
            {bill.ocr_raw_text && bill.ocr_raw_text !== '[image — OCR via Gemini in production]' ? (
              <pre className="text-[11px] text-gray-600 bg-gray-50 rounded-lg p-3 max-h-96 overflow-y-auto scrollbar-thin whitespace-pre-wrap font-mono leading-relaxed">
                {bill.ocr_raw_text}
              </pre>
            ) : (
              <div className="flex flex-col items-center justify-center h-48 bg-gray-50 rounded-lg border border-dashed border-gray-300">
                <span className="text-2xl mb-2">📄</span>
                <p className="text-xs text-gray-400 text-center px-4">
                  {bill.ocr_raw_text === '[image — OCR via Gemini in production]'
                    ? 'Image OCR requires Gemini API key (production mode)'
                    : 'No OCR text stored for this bill'}
                </p>
              </div>
            )}
          </div>

          {/* Right: Editable fields */}
          <div className="p-5">
            <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-3">Extracted Fields — correct if needed</p>
            <div className="space-y-3">
              {EDITABLE.map(f => {
                const flagged = reviewFlags[f.key]
                return (
                  <div key={f.key}>
                    <label className="block text-xs font-semibold text-gray-600 mb-1">
                      {f.label}
                      {flagged && <span className="ml-1.5 text-orange-500 text-[10px]">⚠ {flagged}</span>}
                    </label>
                    <input
                      type={f.type}
                      value={form[f.key] ?? ''}
                      onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                      className={`w-full px-3 py-2 text-sm rounded-lg border outline-none focus:ring-2 focus:ring-blue-300 transition
                        ${flagged ? 'border-orange-300 bg-orange-50' : 'border-gray-200 bg-white'}
                      `}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || done}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-60 transition-colors"
          >
            <Save size={14} />
            {done ? '✓ Saved' : saving ? 'Saving...' : 'Save & Mark Reviewed'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ReviewQueue() {
  const [queue, setQueue]     = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)

  const load = async () => {
    setLoading(true)
    setQueue(await api.reviewQueue())
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  const handleSaved = () => {
    setSelected(null)
    load()
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-extrabold text-gray-900">Review Queue</h1>
          <p className="text-sm text-gray-500 mt-1">
            Low-confidence extractions flagged for human review — click a bill to correct fields
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {queue.length === 0 && !loading ? (
        <div className="bg-white border border-gray-200 shadow-sm rounded-lg">
          <EmptyState icon="✅" message="No bills need review — queue is clear" />
        </div>
      ) : (
        <div className="bg-white border border-gray-200 shadow-sm rounded-lg overflow-hidden">
          <div className="divide-y divide-gray-100">
            {queue.map(bill => {
              const flags = (() => {
                try { return Object.keys(JSON.parse(bill.review_flags || '{}')).length } catch { return 0 }
              })()
              return (
                <button
                  key={bill.bill_id}
                  onClick={() => setSelected(bill)}
                  className="w-full flex items-center gap-4 px-5 py-4 hover:bg-gray-50 transition-colors text-left group"
                >
                  <div className="flex-1 grid grid-cols-5 gap-3 items-center">
                    <div>
                      <p className="text-xs font-bold text-gray-900">{bill.bill_id}</p>
                      <p className="text-[10px] text-gray-400 mt-0.5">{bill.month}</p>
                    </div>
                    <div>
                      <Badge label={bill.discom_id || '—'} variant="blue" />
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">{bill.provider_name || '—'}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500 truncate max-w-[140px]">
                        {bill.source_file || 'Manual entry'}
                      </p>
                    </div>
                    <div>
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-orange-100 text-orange-600 rounded-full text-xs font-semibold">
                        ⚠ {flags} flag{flags !== 1 ? 's' : ''}
                      </span>
                    </div>
                  </div>
                  <ChevronRight size={16} className="text-gray-300 group-hover:text-gray-500 transition-colors flex-shrink-0" />
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Side-by-side review modal */}
      {selected && (
        <ReviewPanel
          bill={selected}
          onClose={() => setSelected(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  )
}

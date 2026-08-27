import { useState, useRef } from 'react'
import { Play, Eraser } from 'lucide-react'
import { api, fmt } from '../api'
import PipelineViz from '../components/PipelineViz'
import Badge from '../components/Badge'

const PIPE_STEPS = [
  { id: 'ingest', label: 'Bill Ingestion' },
  { id: 'parse',  label: 'Line Parser' },
  { id: 'calc',   label: 'Penalty Calc' },
  { id: 'var',    label: 'Variance Detect' },
  { id: 'score',  label: 'Impact Scorer' },
  { id: 'cite',   label: 'Citation Attach' },
  { id: 'sql',    label: 'Write to DB' },
]

const STAGE_LABELS = [
  'Bill ingestion — OCR + extraction + schema validate',
  'bill_line_parser — normalising fields...',
  'tariff_penalty_calculator — deterministic MD/PF recalc...',
  'variance_detector — comparing billed vs recalculated...',
  'dollar_impact_scorer — computing rupee impact + confidence...',
  'citation_attacher — attaching tariff clause refs...',
  'Writing bills + findings to database...',
]

function flagBadge(flag) {
  return flag ? <Badge label={flag} variant={flag} /> : <span className="text-gray-300">—</span>
}

export default function RunBatch() {
  const [running, setRunning]     = useState(false)
  const [activeIdx, setActiveIdx] = useState(-1)
  const [errorIdx, setErrorIdx]   = useState(-1)
  const [logs, setLogs]           = useState([{ text: 'Ready — click Run to start', cls: 'info' }])
  const [results, setResults]     = useState(null)
  const logRef = useRef(null)

  const addLog = (text, cls = 'info') => {
    const ts = new Date().toLocaleTimeString()
    setLogs(prev => [...prev, { text: `[${ts}]  ${text}`, cls }])
    setTimeout(() => logRef.current?.scrollTo(0, logRef.current.scrollHeight), 50)
  }

  const clearLog = () => {
    setLogs([{ text: 'Log cleared', cls: 'info' }])
    setResults(null)
    setActiveIdx(-1)
    setErrorIdx(-1)
  }

  const runBatch = async () => {
    setRunning(true)
    setResults(null)
    setActiveIdx(-1)
    setErrorIdx(-1)
    setLogs([])
    addLog('Starting batch run — 3 fixtures (MSEDCL, TSSPDCL, BESCOM)...')

    // Animate stages while fetching
    let stageIdx = 0
    const anim = setInterval(() => {
      if (stageIdx < PIPE_STEPS.length) {
        setActiveIdx(stageIdx)
        addLog(STAGE_LABELS[stageIdx])
        stageIdx++
      } else {
        clearInterval(anim)
      }
    }, 400)

    try {
      const data = await api.runBatch()
      clearInterval(anim)
      await new Promise(r => setTimeout(r, 200))
      setActiveIdx(PIPE_STEPS.length)

      if (data.error) {
        addLog('ERROR: ' + data.error, 'err')
        setErrorIdx(PIPE_STEPS.length - 1)
      } else {
        let total = 0
        data.results?.forEach(res => {
          if (res.error) {
            addLog(`[${res.bill_id}] ERROR: ${res.error}`, 'err')
          } else {
            const p2 = res.pipeline_2 || {}
            const impact = p2.total_rupee_impact || 0
            total += impact
            const mat = p2.materiality_flag ? '⚠ MATERIAL' : 'below threshold'
            addLog(
              `[${res.bill_id}]  impact=${fmt.inr(impact)}  conf=${p2.confidence_score}%  ${mat}`,
              impact > 0 ? 'warn' : 'ok',
            )
          }
        })
        addLog(`Batch complete. Total overcharges: ${fmt.inr(total)}`, 'ok')
        setResults(data.results)
      }
    } catch (e) {
      clearInterval(anim)
      setErrorIdx(stageIdx - 1)
      addLog('Network error: ' + e.message, 'err')
    }
    setRunning(false)
  }

  const logCls = { ok: 'text-green-600', err: 'text-red-500', warn: 'text-orange-500', info: 'text-gray-500' }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-extrabold text-gray-900 mb-1">Run Full Pipeline</h1>
      <p className="text-sm text-gray-500 mb-6">Processes all 3 fixture bills through both pipelines end-to-end</p>

      {/* Pipeline viz */}
      <div className="bg-white border border-gray-200 shadow-sm rounded-lg p-5 mb-5">
        <PipelineViz steps={PIPE_STEPS} activeIdx={activeIdx} errorIdx={errorIdx} />
      </div>

      {/* Controls */}
      <div className="flex gap-3 mb-5">
        <button
          onClick={runBatch}
          disabled={running}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Play size={14} />
          {running ? 'Running...' : 'Run All 3 Fixtures'}
        </button>
        <button
          onClick={clearLog}
          disabled={running}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
        >
          <Eraser size={14} />
          Clear
        </button>
      </div>

      {/* Log */}
      <div className="bg-white border border-gray-200 shadow-sm rounded-lg overflow-hidden mb-6">
        <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-200">
          <span className="text-xs font-bold text-gray-500 uppercase tracking-wide">Pipeline Log</span>
        </div>
        <div
          ref={logRef}
          className="p-4 font-mono text-xs space-y-0.5 max-h-64 overflow-y-auto scrollbar-thin bg-gray-950"
        >
          {logs.map((l, i) => (
            <div key={i} className={logCls[l.cls] || 'text-gray-400'}>{l.text}</div>
          ))}
        </div>
      </div>

      {/* Results table */}
      {results && (
        <div className="bg-white border border-gray-200 shadow-sm rounded-lg overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-200">
            <h2 className="text-sm font-bold text-gray-900">Results</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  {['Bill ID', 'DISCOM', 'MD Status', 'PF Status', 'Rupee Impact', 'Confidence', 'Material'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {results.map(res => {
                  if (res.error) return (
                    <tr key={res.bill_id}>
                      <td colSpan={7} className="px-4 py-3 text-red-500 text-xs">{res.bill_id}: {res.error}</td>
                    </tr>
                  )
                  const p2  = res.pipeline_2 || {}
                  const bd  = p2.breakdown || []
                  const md  = bd.find(b => b.finding_type === 'MD_PENALTY')
                  const pf  = bd.find(b => b.finding_type === 'PF_PENALTY')
                  const discom = p2.findings?.[0]?.citation_discom || '—'
                  return (
                    <tr key={res.bill_id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3"><Badge label={res.bill_id} variant="blue" /></td>
                      <td className="px-4 py-3 text-gray-600 text-xs font-medium">{discom}</td>
                      <td className="px-4 py-3">{flagBadge(md?.variance_flag)}</td>
                      <td className="px-4 py-3">{flagBadge(pf?.variance_flag)}</td>
                      <td className={`px-4 py-3 font-bold ${(p2.total_rupee_impact || 0) > 0 ? 'text-red-600' : 'text-green-600'}`}>
                        {fmt.inr(p2.total_rupee_impact)}
                      </td>
                      <td className="px-4 py-3 text-gray-700">{p2.confidence_score || 0}%</td>
                      <td className="px-4 py-3">
                        {p2.materiality_flag
                          ? <Badge label="⚠ YES" variant="red" />
                          : <Badge label="NO" variant="gray" />}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api, fmt } from '../api'
import Badge from '../components/Badge'
import EmptyState from '../components/EmptyState'

export default function Findings() {
  const [findings, setFindings] = useState([])
  const [loading, setLoading]   = useState(true)
  const [tooltip, setTooltip]   = useState(null)

  const load = async () => {
    setLoading(true)
    setFindings(await api.findings())
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-extrabold text-gray-900">Findings</h1>
          <p className="text-sm text-gray-500 mt-1">MD &amp; PF penalty variances with tariff citations</p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="bg-white border border-gray-200 shadow-sm rounded-lg overflow-hidden">
        {findings.length === 0 && !loading ? (
          <EmptyState icon="🔍" message="No findings yet — run a batch first" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  {['Finding ID', 'Bill', 'Type', 'Flag', 'Billed', 'Recalculated', 'Impact', 'Confidence', 'Citation'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {findings.map(f => (
                  <tr key={f.finding_id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-gray-400">{f.finding_id}</td>
                    <td className="px-4 py-3"><Badge label={f.bill_id} variant="blue" /></td>
                    <td className="px-4 py-3"><Badge label={f.finding_type} variant={f.finding_type} /></td>
                    <td className="px-4 py-3"><Badge label={f.variance_flag} variant={f.variance_flag} /></td>
                    <td className="px-4 py-3 text-gray-700 text-xs">{fmt.inr(f.billed_amount)}</td>
                    <td className="px-4 py-3 text-gray-700 text-xs">{fmt.inr(f.recalculated_amount)}</td>
                    <td className={`px-4 py-3 font-bold text-xs ${(f.rupee_impact || 0) > 0 ? 'text-red-600' : 'text-green-600'}`}>
                      {fmt.inr(f.rupee_impact)}
                    </td>
                    <td className="px-4 py-3 text-gray-600 text-xs">{(f.confidence_score || 0).toFixed(1)}%</td>
                    <td className="px-4 py-3 max-w-[220px]">
                      <span
                        className="text-xs text-blue-600 underline decoration-dotted cursor-help truncate block"
                        title={f.citation_clause_ref}
                      >
                        {f.citation_clause_ref || '—'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { RefreshCw, TrendingDown, FileText, AlertTriangle, Search, Percent } from 'lucide-react'
import { api, fmt } from '../api'
import KpiCard from '../components/KpiCard'
import Badge from '../components/Badge'
import EmptyState from '../components/EmptyState'

export default function Dashboard() {
  const [stats, setStats]           = useState(null)
  const [overcharged, setOvercharged] = useState([])
  const [loading, setLoading]       = useState(true)

  const load = async () => {
    setLoading(true)
    const [s, o] = await Promise.all([api.stats(), api.overcharged()])
    setStats(s)
    setOvercharged(o)
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-extrabold text-gray-900">Audit Dashboard</h1>
          <p className="text-sm text-gray-500 mt-1">
            Real-time billing anomaly detection across MSEDCL · TSSPDCL · BESCOM
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

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        <KpiCard
          label="Bills Processed"
          value={stats?.total_bills ?? '—'}
          sub="Across all sites"
          color="blue"
          icon={FileText}
        />
        <KpiCard
          label="Rupee Overcharged"
          value={stats ? fmt.inr(stats.total_rupee_impact) : '—'}
          sub="Identified overcharges"
          color="red"
          icon={TrendingDown}
        />
        <KpiCard
          label="Needs Review"
          value={stats?.bills_needs_review ?? '—'}
          sub="Low-confidence extractions"
          color="orange"
          icon={AlertTriangle}
        />
        <KpiCard
          label="Findings"
          value={stats?.total_findings ?? '—'}
          sub="MD + PF variances"
          color="green"
          icon={Search}
        />
        <KpiCard
          label="Avg Confidence"
          value={stats ? fmt.pct(stats.avg_confidence) : '—'}
          sub="Scoring accuracy"
          color="gray"
          icon={Percent}
        />
      </div>

      {/* Overcharged Findings */}
      <div className="bg-white border border-gray-200 shadow-sm rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-sm font-bold text-gray-900">🔴 Overcharged Findings</h2>
          <span className="text-xs text-gray-400">{overcharged.length} records</span>
        </div>

        {overcharged.length === 0 ? (
          <EmptyState icon="⚡" message="Run a batch to see overcharged findings" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  {['Finding ID', 'Bill', 'Type', 'Billed', 'Should Be', 'Overcharge', 'Citation', 'Source'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {overcharged.map(f => (
                  <tr key={f.finding_id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">{f.finding_id}</td>
                    <td className="px-4 py-3"><Badge label={f.bill_id} variant="blue" /></td>
                    <td className="px-4 py-3"><Badge label={f.finding_type} variant={f.finding_type} /></td>
                    <td className="px-4 py-3 text-gray-700">{fmt.inr(f.billed_amount)}</td>
                    <td className="px-4 py-3 text-gray-700">{fmt.inr(f.recalculated_amount)}</td>
                    <td className="px-4 py-3 font-bold text-red-600">{fmt.inr(f.rupee_impact)}</td>
                    <td className="px-4 py-3 max-w-[200px]">
                      <span className="text-xs text-gray-500 truncate block" title={f.citation_clause_ref}>
                        {f.citation_clause_ref || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3"><Badge label={f.citation_source || '—'} variant="gray" /></td>
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

import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api, fmt } from '../api'
import Badge from '../components/Badge'
import EmptyState from '../components/EmptyState'

export default function Bills() {
  const [bills, setBills]   = useState([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    setBills(await api.bills())
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-extrabold text-gray-900">Bills</h1>
          <p className="text-sm text-gray-500 mt-1">All ingested bills with extraction metadata</p>
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
        {bills.length === 0 && !loading ? (
          <EmptyState icon="🧾" message="No bills yet — run a batch first" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  {['Bill ID', 'Site', 'Month', 'DISCOM', 'Provider', 'CD (kVA)', 'MD (kVA)', 'PF', 'Total Due', 'Status', 'Review'].map(h => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {bills.map(b => (
                  <tr key={b.bill_id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">{b.bill_id}</td>
                    <td className="px-4 py-3 text-gray-700 text-xs">{b.site_id}</td>
                    <td className="px-4 py-3 text-gray-700 text-xs">{b.month}</td>
                    <td className="px-4 py-3"><Badge label={b.discom_id || '—'} variant="blue" /></td>
                    <td className="px-4 py-3 text-gray-600 text-xs">{b.provider_name || '—'}</td>
                    <td className="px-4 py-3 text-gray-700 text-xs">{b.contract_demand_kva ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-700 text-xs">{b.recorded_max_demand_kva ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-700 text-xs">{b.power_factor ?? '—'}</td>
                    <td className="px-4 py-3 font-semibold text-gray-900 text-xs">{fmt.inr(b.total_due)}</td>
                    <td className="px-4 py-3"><Badge label={b.payment_status || '—'} variant={b.payment_status} /></td>
                    <td className="px-4 py-3">
                      {b.needs_review
                        ? <Badge label="⚠ Review" variant="orange" />
                        : <Badge label="✓ OK"     variant="green" />}
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

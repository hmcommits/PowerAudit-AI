// KpiCard — white card on gray-50 canvas, color-accented top border
const BORDER = {
  blue:   'border-t-blue-500',
  green:  'border-t-green-500',
  red:    'border-t-red-500',
  orange: 'border-t-orange-500',
  gray:   'border-t-gray-300',
}
const VALUE_COLOR = {
  blue:   'text-blue-600',
  green:  'text-green-600',
  red:    'text-red-600',
  orange: 'text-orange-500',
  gray:   'text-gray-700',
}

export default function KpiCard({ label, value, sub, color = 'blue', icon: Icon }) {
  return (
    <div className={`bg-white border border-gray-200 border-t-4 ${BORDER[color]} shadow-sm rounded-lg p-5 flex flex-col gap-1`}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">{label}</span>
        {Icon && <Icon size={18} className={VALUE_COLOR[color]} strokeWidth={2} />}
      </div>
      <div className={`text-2xl font-extrabold leading-tight ${VALUE_COLOR[color]}`}>{value ?? '—'}</div>
      {sub && <div className="text-xs text-gray-400">{sub}</div>}
    </div>
  )
}

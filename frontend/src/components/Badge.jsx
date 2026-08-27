// Badge — traffic-light status pills per design spec
const MAP = {
  // Variance flags
  OVERCHARGED:  'bg-red-100 text-red-600',
  UNDERCHARGED: 'bg-orange-100 text-orange-600',
  MATCH:        'bg-green-100 text-green-700',
  INCONCLUSIVE: 'bg-gray-100 text-gray-500',
  // Review
  review:       'bg-orange-100 text-orange-600',
  ok:           'bg-green-100 text-green-700',
  // Payment
  Overdue:      'bg-red-100 text-red-600',
  Pending:      'bg-orange-100 text-orange-600',
  Paid:         'bg-green-100 text-green-700',
  Partial:      'bg-blue-100 text-blue-600',
  // Finding type
  MD_PENALTY:      'bg-red-100 text-red-600',
  PF_PENALTY:      'bg-orange-100 text-orange-600',
  TARIFF_MISMATCH: 'bg-purple-100 text-purple-600',
  // Generic
  blue:   'bg-blue-100 text-blue-600',
  gray:   'bg-gray-100 text-gray-500',
  green:  'bg-green-100 text-green-700',
  red:    'bg-red-100 text-red-600',
  orange: 'bg-orange-100 text-orange-600',
}

export default function Badge({ label, variant, className = '' }) {
  const cls = MAP[variant] || MAP[label] || 'bg-gray-100 text-gray-500'
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${cls} ${className}`}>
      {label}
    </span>
  )
}

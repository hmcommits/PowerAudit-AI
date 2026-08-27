// EmptyState — centred empty placeholder for tables
export default function EmptyState({ icon = '📭', message = 'No data yet' }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-gray-400">
      <span className="text-4xl mb-3">{icon}</span>
      <p className="text-sm font-medium">{message}</p>
    </div>
  )
}

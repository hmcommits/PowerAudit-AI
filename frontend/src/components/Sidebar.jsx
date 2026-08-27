import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard, Play, FileInput, FileText,
  Search, AlertTriangle, Zap,
} from 'lucide-react'

const NAV = [
  { label: 'Overview', items: [
    { to: '/',        icon: LayoutDashboard, label: 'Dashboard' },
  ]},
  { label: 'Pipeline', items: [
    { to: '/run',     icon: Play,      label: 'Run Batch' },
    { to: '/ingest',  icon: FileInput, label: 'Ingest Bill' },
  ]},
  { label: 'Data', items: [
    { to: '/bills',    icon: FileText,     label: 'Bills' },
    { to: '/findings', icon: Search,       label: 'Findings' },
    { to: '/review',   icon: AlertTriangle, label: 'Review Queue' },
  ]},
]

export default function Sidebar() {
  return (
    <aside className="w-64 bg-white border-r border-gray-200 flex flex-col h-screen sticky top-0">
      {/* Logo */}
      <div className="px-5 py-4 border-b border-gray-200">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
            <Zap size={16} className="text-white" strokeWidth={2.5} />
          </div>
          <div>
            <p className="text-sm font-bold text-gray-900 leading-tight">PowerAudit AI</p>
            <p className="text-[10px] text-gray-400 font-medium">Electricity Bill Audit</p>
          </div>
        </div>
        <span className="mt-2 inline-flex items-center gap-1.5 text-[10px] font-semibold text-green-600 bg-green-50 px-2 py-0.5 rounded-full">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
          Local Mode
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-3">
        {NAV.map(section => (
          <div key={section.label} className="mb-4">
            <p className="px-2 mb-1 text-[10px] font-bold text-gray-400 uppercase tracking-widest">
              {section.label}
            </p>
            {section.items.map(({ to, icon: Icon, label }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium mb-0.5 transition-colors
                  ${isActive
                    ? 'bg-blue-50 text-blue-600'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon size={15} strokeWidth={isActive ? 2.5 : 2} />
                    {label}
                  </>
                )}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-gray-200 text-[10px] text-gray-400">
        MSEDCL · TSSPDCL · BESCOM
      </div>
    </aside>
  )
}

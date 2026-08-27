import { CheckCircle, Circle, Loader, XCircle } from 'lucide-react'

// Steps: array of { id, label }
// activeIdx: index currently running (-1 = not started, steps.length = done)
// errorIdx: index that errored (-1 = none)

const STEP_ICONS = {
  done:    <CheckCircle size={20} className="text-green-500" strokeWidth={2} />,
  running: <Loader     size={20} className="text-blue-600 animate-spin" strokeWidth={2} />,
  error:   <XCircle   size={20} className="text-red-500" strokeWidth={2} />,
  idle:    <Circle    size={20} className="text-gray-300" strokeWidth={2} />,
}

function stepState(idx, activeIdx, errorIdx) {
  if (errorIdx === idx) return 'error'
  if (idx < activeIdx)  return 'done'
  if (idx === activeIdx) return 'running'
  return 'idle'
}

export default function PipelineViz({ steps, activeIdx = -1, errorIdx = -1 }) {
  return (
    <div className="flex items-start gap-0 overflow-x-auto pb-2">
      {steps.map((step, i) => {
        const state = stepState(i, activeIdx, errorIdx)
        return (
          <div key={step.id} className="flex items-center">
            {/* Node */}
            <div className="flex flex-col items-center min-w-[90px] gap-1.5">
              <div className={`w-12 h-12 rounded-xl flex items-center justify-center border-2 text-lg transition-all duration-300
                ${state === 'done'    ? 'border-green-300 bg-green-50' : ''}
                ${state === 'running' ? 'border-blue-400 bg-blue-50 shadow-md shadow-blue-100' : ''}
                ${state === 'error'   ? 'border-red-300 bg-red-50' : ''}
                ${state === 'idle'    ? 'border-gray-200 bg-gray-50' : ''}
              `}>
                {STEP_ICONS[state]}
              </div>
              <span className={`text-[10px] font-medium text-center leading-tight max-w-[80px]
                ${state === 'running' ? 'text-blue-600' : ''}
                ${state === 'done'    ? 'text-green-600' : ''}
                ${state === 'error'   ? 'text-red-500'   : ''}
                ${state === 'idle'    ? 'text-gray-400'  : ''}
              `}>{step.label}</span>
            </div>
            {/* Arrow connector */}
            {i < steps.length - 1 && (
              <div className={`w-8 h-0.5 mx-0.5 flex-shrink-0 transition-colors duration-300
                ${i < activeIdx ? 'bg-green-300' : 'bg-gray-200'}
              `} />
            )}
          </div>
        )
      })}
    </div>
  )
}

import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Sidebar    from './components/Sidebar'
import Dashboard  from './pages/Dashboard'
import RunBatch   from './pages/RunBatch'
import IngestBill from './pages/IngestBill'
import Bills      from './pages/Bills'
import Findings   from './pages/Findings'
import ReviewQueue from './pages/ReviewQueue'

export default function App() {
  return (
    <BrowserRouter>
      <div className="flex min-h-screen bg-gray-50">
        <Sidebar />
        <main className="flex-1 overflow-y-auto">
          <Routes>
            <Route path="/"        element={<Dashboard />} />
            <Route path="/run"     element={<RunBatch />} />
            <Route path="/ingest"  element={<IngestBill />} />
            <Route path="/bills"   element={<Bills />} />
            <Route path="/findings" element={<Findings />} />
            <Route path="/review"  element={<ReviewQueue />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}

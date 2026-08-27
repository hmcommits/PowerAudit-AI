// api.js
// Centralised fetch layer. All components import from here.

const base = ''  // Vite proxies /api/* → Flask :5000

export const api = {
  stats:        () => fetch(`${base}/api/stats`).then(r => r.json()),
  bills:        () => fetch(`${base}/api/bills`).then(r => r.json()),
  bill:         (id) => fetch(`${base}/api/bills/${id}`).then(r => r.json()),
  findings:     () => fetch(`${base}/api/findings`).then(r => r.json()),
  overcharged:  () => fetch(`${base}/api/findings/overcharged`).then(r => r.json()),
  sites:        () => fetch(`${base}/api/sites`).then(r => r.json()),
  reviewQueue:  () => fetch(`${base}/api/review-queue`).then(r => r.json()),

  lookupConsumer: (consumerNo) =>
    fetch(`${base}/api/bills/lookup?consumer_no=${encodeURIComponent(consumerNo)}`).then(r => r.json()),

  uploadBill: (file) => {
    const form = new FormData()
    form.append('file', file)
    return fetch(`${base}/api/upload-bill`, { method: 'POST', body: form }).then(r => r.json())
  },

  ingestBill: (body) =>
    fetch(`${base}/api/ingest-bill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json()),

  runBatch: () =>
    fetch(`${base}/api/run-batch`, { method: 'POST' }).then(r => r.json()),

  submitReview: (billId, body) =>
    fetch(`${base}/api/submit-review/${billId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json()),
}

// Helpers
export const fmt = {
  inr: (n) =>
    `₹${(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`,
  pct: (n) => `${(n || 0).toFixed(1)}%`,
  num: (n) => (n == null ? '—' : n),
}

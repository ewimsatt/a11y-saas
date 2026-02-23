import { useEffect, useMemo, useState } from 'react'

type Project = { id: string; name: string; baseUrl: string; _count?: { scans: number } }
type ScanIssue = {
  id: string
  severity: 'CRITICAL' | 'SERIOUS' | 'MODERATE' | 'MINOR'
  status: 'OPEN' | 'FIXED' | 'REGRESSED' | 'WAIVED'
  message: string
  selector?: string | null
  rule?: { id: string; title: string; wcagRefs: string[] }
}

type Evidence = {
  issueId: string
  screenshot: string
  domSnippet?: string
  meta?: { title?: string; url?: string }
}

const API = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001'

export default function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('')
  const [scanId, setScanId] = useState('')
  const [issues, setIssues] = useState<ScanIssue[]>([])
  const [selectedIssue, setSelectedIssue] = useState<ScanIssue | null>(null)
  const [evidence, setEvidence] = useState<Evidence | null>(null)
  const [severityFilter, setSeverityFilter] = useState('ALL')
  const [statusFilter, setStatusFilter] = useState('ALL')
  const [wcagFilter, setWcagFilter] = useState('')
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectUrl, setNewProjectUrl] = useState('')
  const [waiveReason, setWaiveReason] = useState('')
  const [msg, setMsg] = useState('')

  async function loadProjects() {
    const res = await fetch(`${API}/projects`)
    const data = await res.json()
    setProjects(data)
    if (!projectId && data[0]?.id) setProjectId(data[0].id)
  }

  useEffect(() => { void loadProjects() }, [])

  async function createProject() {
    if (!newProjectName || !newProjectUrl) return
    const res = await fetch(`${API}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: newProjectName, baseUrl: newProjectUrl })
    })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setMsg(`Create project failed: ${j.error || res.statusText}`)
      return
    }
    setNewProjectName('')
    setNewProjectUrl('')
    setMsg('Project created')
    await loadProjects()
  }

  async function runScan() {
    if (!projectId) return
    const res = await fetch(`${API}/scans/${projectId}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const j = await res.json()
    if (!res.ok) {
      setMsg(`Run scan failed: ${j.error || res.statusText}`)
      return
    }
    setScanId(j.scanId)
    setMsg(`Scan queued: ${j.scanId}`)
  }

  async function loadIssues() {
    if (!scanId) return
    const res = await fetch(`${API}/scans/${scanId}/issues`)
    const j = await res.json()
    setIssues(j.issues || [])
    setMsg(`Loaded ${j.issues?.length || 0} issues`)
  }

  async function openEvidence(issue: ScanIssue) {
    setSelectedIssue(issue)
    const res = await fetch(`${API}/issues/${issue.id}/evidence`)
    if (!res.ok) {
      setEvidence(null)
      return
    }
    setEvidence(await res.json())
  }

  async function waiveIssue() {
    if (!selectedIssue || waiveReason.length < 10) return
    const res = await fetch(`${API}/issues/${selectedIssue.id}/waive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: waiveReason })
    })
    if (!res.ok) {
      const j = await res.json().catch(() => ({}))
      setMsg(`Waive failed: ${j.error || res.statusText}`)
      return
    }
    setMsg(`Waived issue ${selectedIssue.id}`)
    setWaiveReason('')
    await loadIssues()
  }

  const filtered = useMemo(() => {
    return issues.filter((i) => {
      if (severityFilter !== 'ALL' && i.severity !== severityFilter) return false
      if (statusFilter !== 'ALL' && i.status !== statusFilter) return false
      if (wcagFilter && !(i.rule?.wcagRefs || []).join(' ').toLowerCase().includes(wcagFilter.toLowerCase())) return false
      return true
    })
  }, [issues, severityFilter, statusFilter, wcagFilter])

  return (
    <main className="app">
      <header>
        <h1>A11Y SaaS - Issues Console</h1>
        <p>Projects, scans, issue triage, evidence, and waivers.</p>
      </header>

      <section className="panel controls">
        <h2>Project + Scan</h2>
        <div className="row">
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Select project</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button onClick={runScan}>Run Scan</button>
          <input value={scanId} onChange={(e) => setScanId(e.target.value)} placeholder="Scan ID" />
          <button onClick={loadIssues}>Load Issues</button>
        </div>
        <div className="row">
          <input value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} placeholder="New project name" />
          <input value={newProjectUrl} onChange={(e) => setNewProjectUrl(e.target.value)} placeholder="https://example.com" />
          <button onClick={createProject}>Create Project</button>
        </div>
      </section>

      <div className="grid">
        <section className="panel">
          <h2>Issues</h2>
          <div className="row">
            <select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)}>
              <option>ALL</option><option>CRITICAL</option><option>SERIOUS</option><option>MODERATE</option><option>MINOR</option>
            </select>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option>ALL</option><option>OPEN</option><option>FIXED</option><option>REGRESSED</option><option>WAIVED</option>
            </select>
            <input value={wcagFilter} onChange={(e) => setWcagFilter(e.target.value)} placeholder="WCAG contains (e.g. 1.3.1)" />
          </div>
          <table>
            <thead>
              <tr><th>Severity</th><th>Status</th><th>WCAG</th><th>Message</th></tr>
            </thead>
            <tbody>
              {filtered.map((i) => (
                <tr key={i.id} onClick={() => void openEvidence(i)} className={selectedIssue?.id === i.id ? 'active' : ''}>
                  <td>{i.severity}</td>
                  <td>{i.status}</td>
                  <td>{(i.rule?.wcagRefs || []).join(', ') || '-'}</td>
                  <td>{i.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <aside className="panel">
          <h2>Evidence</h2>
          {!selectedIssue && <p>Select an issue row to load evidence.</p>}
          {selectedIssue && (
            <>
              <p><strong>Issue:</strong> {selectedIssue.id}</p>
              {evidence?.meta?.url && <p><strong>URL:</strong> {evidence.meta.url}</p>}
              {evidence?.screenshot && (
                <img src={`${API}${evidence.screenshot}`} alt="Evidence screenshot" className="shot" />
              )}
              <pre>{evidence?.domSnippet || selectedIssue.selector || 'No DOM snippet available.'}</pre>

              <h3>Waive</h3>
              <textarea value={waiveReason} onChange={(e) => setWaiveReason(e.target.value)} placeholder="Reason (min 10 chars)" rows={4} />
              <button onClick={waiveIssue}>Waive Issue</button>
            </>
          )}
        </aside>
      </div>

      {msg && <footer className="msg">{msg}</footer>}
    </main>
  )
}

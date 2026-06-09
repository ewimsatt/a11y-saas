import { useEffect, useMemo, useRef, useState } from 'react'

type Project = { id: string; name: string; baseUrl: string; _count?: { scans: number } }
type Scan = {
  id: string
  status: string
  startedAt?: string | null
  completedAt?: string | null
  _count?: { findings: number; pages: number }
}
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
  meta?: { title?: string; url?: string; failureSummary?: string }
}

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'
const POLL_INTERVAL_MS = 2000
const POLL_MAX_ATTEMPTS = 90

export default function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('')
  const [scans, setScans] = useState<Scan[]>([])
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
  const [reportFormat, setReportFormat] = useState<'pdf' | 'pptx' | 'html'>('pdf')
  const [msg, setMsg] = useState('')
  const pollToken = useRef(0)

  function applyPreset(preset: 'critical-open' | 'all-open' | 'wcag-131') {
    if (preset === 'critical-open') {
      setSeverityFilter('CRITICAL')
      setStatusFilter('OPEN')
      setWcagFilter('')
      return
    }
    if (preset === 'all-open') {
      setSeverityFilter('ALL')
      setStatusFilter('OPEN')
      setWcagFilter('')
      return
    }
    setSeverityFilter('ALL')
    setStatusFilter('ALL')
    setWcagFilter('1.3.1')
  }

  async function loadProjects() {
    try {
      const res = await fetch(`${API}/projects`)
      if (!res.ok) throw new Error(res.statusText)
      const data = await res.json()
      setProjects(data)
      if (!projectId && data[0]?.id) setProjectId(data[0].id)
    } catch (e) {
      setMsg(`Failed to load projects: ${e instanceof Error ? e.message : 'network error'}`)
    }
  }

  async function loadScans(pid: string) {
    if (!pid) {
      setScans([])
      return
    }
    try {
      const res = await fetch(`${API}/projects/${pid}/scans`)
      if (!res.ok) throw new Error(res.statusText)
      const j = await res.json()
      setScans(j.scans || [])
    } catch (e) {
      setMsg(`Failed to load scans: ${e instanceof Error ? e.message : 'network error'}`)
    }
  }

  useEffect(() => { void loadProjects() }, [])
  useEffect(() => { void loadScans(projectId) }, [projectId])
  // Invalidate any in-flight scan poll on unmount.
  useEffect(() => () => { pollToken.current += 1 }, [])

  async function createProject() {
    if (!newProjectName || !newProjectUrl) return
    try {
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
    } catch (e) {
      setMsg(`Create project failed: ${e instanceof Error ? e.message : 'network error'}`)
    }
  }

  async function loadIssues(id?: string) {
    const target = id ?? scanId
    if (!target) return
    try {
      const res = await fetch(`${API}/scans/${target}/issues`)
      if (!res.ok) throw new Error(res.statusText)
      const j = await res.json()
      setIssues(j.issues || [])
      setMsg(`Loaded ${j.issues?.length || 0} issues`)
    } catch (e) {
      setMsg(`Failed to load issues: ${e instanceof Error ? e.message : 'network error'}`)
    }
  }

  async function pollScan(id: string, pid: string) {
    const token = ++pollToken.current
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      if (pollToken.current !== token) return
      try {
        const res = await fetch(`${API}/scans/${id}`)
        if (!res.ok) continue
        const scan: Scan = await res.json()
        if (pollToken.current !== token) return
        if (scan.status === 'completed') {
          setMsg(`Scan completed: ${scan._count?.findings ?? 0} findings`)
          await loadIssues(id)
          await loadScans(pid)
          return
        }
        if (scan.status === 'failed') {
          setMsg('Scan failed — check the worker logs')
          await loadScans(pid)
          return
        }
        setMsg(`Scan ${scan.status}...`)
      } catch {
        // transient network error; keep polling
      }
    }
    setMsg('Scan is taking a while — use Load Issues to check later')
  }

  async function runScan() {
    if (!projectId) return
    try {
      const res = await fetch(`${API}/scans/${projectId}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      })
      const j = await res.json()
      if (!res.ok) {
        setMsg(`Run scan failed: ${j.error || res.statusText}`)
        return
      }
      setScanId(j.scanId)
      setMsg(`Scan queued: ${j.scanId}`)
      void pollScan(j.scanId, projectId)
    } catch (e) {
      setMsg(`Run scan failed: ${e instanceof Error ? e.message : 'network error'}`)
    }
  }

  async function openEvidence(issue: ScanIssue) {
    setSelectedIssue(issue)
    try {
      const res = await fetch(`${API}/issues/${issue.id}/evidence`)
      if (!res.ok) {
        setEvidence(null)
        return
      }
      setEvidence(await res.json())
    } catch {
      setEvidence(null)
    }
  }

  async function waiveIssue() {
    if (!selectedIssue || waiveReason.length < 10) return
    try {
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
    } catch (e) {
      setMsg(`Waive failed: ${e instanceof Error ? e.message : 'network error'}`)
    }
  }

  function exportReport() {
    if (!scanId) {
      setMsg('Select a scan to export a report')
      return
    }
    window.open(`${API}/scans/${scanId}/report?format=${reportFormat}`, '_blank', 'noopener')
    setMsg(reportFormat === 'html' ? 'Opening report preview...' : `Downloading ${reportFormat.toUpperCase()} report...`)
  }

  const filtered = useMemo(() => {
    return issues.filter((i) => {
      if (severityFilter !== 'ALL' && i.severity !== severityFilter) return false
      if (statusFilter !== 'ALL' && i.status !== statusFilter) return false
      if (wcagFilter && !(i.rule?.wcagRefs || []).join(' ').toLowerCase().includes(wcagFilter.toLowerCase())) return false
      return true
    })
  }, [issues, severityFilter, statusFilter, wcagFilter])

  function scanLabel(s: Scan) {
    const when = s.startedAt ? new Date(s.startedAt).toLocaleString() : 'unknown time'
    const findings = s._count ? ` - ${s._count.findings} findings` : ''
    return `${when} [${s.status}]${findings}`
  }

  return (
    <main className="app">
      <header>
        <h1>A11Y SaaS - Issues Console</h1>
        <p>Projects, scans, issue triage, evidence, and waivers.</p>
      </header>

      <section className="panel controls" aria-labelledby="project-scan-heading">
        <h2 id="project-scan-heading">Project + Scan</h2>
        <div className="row">
          <select aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Select project</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button onClick={runScan}>Run Scan</button>
          <select
            aria-label="Scan"
            value={scans.some((s) => s.id === scanId) ? scanId : ''}
            onChange={(e) => setScanId(e.target.value)}
          >
            <option value="">Select scan</option>
            {scans.map((s) => <option key={s.id} value={s.id}>{scanLabel(s)}</option>)}
          </select>
          <button onClick={() => void loadIssues()}>Load Issues</button>
        </div>
        <div className="row">
          <input aria-label="New project name" value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} placeholder="New project name" />
          <input aria-label="New project base URL" value={newProjectUrl} onChange={(e) => setNewProjectUrl(e.target.value)} placeholder="https://example.com" />
          <button onClick={createProject}>Create Project</button>
        </div>
        <div className="row">
          <select
            aria-label="Report format"
            value={reportFormat}
            onChange={(e) => setReportFormat(e.target.value as 'pdf' | 'pptx' | 'html')}
          >
            <option value="pdf">PDF document</option>
            <option value="pptx">Slide deck (PowerPoint)</option>
            <option value="html">HTML preview</option>
          </select>
          <button onClick={exportReport} disabled={!scanId}>Export Report</button>
        </div>
      </section>

      <div className="grid">
        <section className="panel" aria-labelledby="issues-heading">
          <h2 id="issues-heading">Issues</h2>
          <div className="row">
            <select aria-label="Filter by severity" value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value)}>
              <option>ALL</option><option>CRITICAL</option><option>SERIOUS</option><option>MODERATE</option><option>MINOR</option>
            </select>
            <select aria-label="Filter by status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option>ALL</option><option>OPEN</option><option>FIXED</option><option>REGRESSED</option><option>WAIVED</option>
            </select>
            <input aria-label="Filter by WCAG reference" value={wcagFilter} onChange={(e) => setWcagFilter(e.target.value)} placeholder="WCAG contains (e.g. 1.3.1)" />
          </div>
          <div className="row">
            <button className="ghost" onClick={() => applyPreset('critical-open')}>Preset: Critical + Open</button>
            <button className="ghost" onClick={() => applyPreset('all-open')}>Preset: All Open</button>
            <button className="ghost" onClick={() => applyPreset('wcag-131')}>Preset: WCAG 1.3.1</button>
          </div>
          <table>
            <thead>
              <tr>
                <th scope="col">Severity</th>
                <th scope="col">Status</th>
                <th scope="col">WCAG</th>
                <th scope="col">Message</th>
                <th scope="col"><span className="visually-hidden">Evidence</span></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((i) => (
                <tr key={i.id} onClick={() => void openEvidence(i)} className={selectedIssue?.id === i.id ? 'active' : ''}>
                  <td>{i.severity}</td>
                  <td>{i.status}</td>
                  <td>{(i.rule?.wcagRefs || []).join(', ') || '-'}</td>
                  <td>{i.message}</td>
                  <td>
                    <button
                      className="ghost"
                      onClick={(e) => { e.stopPropagation(); void openEvidence(i) }}
                      aria-label={`View evidence for ${i.severity.toLowerCase()} issue: ${i.message}`}
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <aside className="panel" aria-labelledby="evidence-heading">
          <h2 id="evidence-heading">Evidence</h2>
          {!selectedIssue && <p>Select an issue to load evidence.</p>}
          {selectedIssue && (
            <>
              <p><strong>Issue:</strong> {selectedIssue.id}</p>
              {evidence?.meta?.url && <p><strong>URL:</strong> {evidence.meta.url}</p>}
              {evidence?.screenshot && (
                <img
                  src={`${API}${evidence.screenshot}`}
                  alt={evidence.meta?.title ? `Full-page screenshot of ${evidence.meta.title}` : 'Full-page screenshot of the scanned page'}
                  className="shot"
                />
              )}
              {evidence?.meta?.failureSummary && <p>{evidence.meta.failureSummary}</p>}
              <pre>{evidence?.domSnippet || selectedIssue.selector || 'No DOM snippet available.'}</pre>

              <h3 id="waive-heading">Waive</h3>
              <textarea
                aria-labelledby="waive-heading"
                value={waiveReason}
                onChange={(e) => setWaiveReason(e.target.value)}
                placeholder="Reason (min 10 chars)"
                rows={4}
              />
              <button onClick={waiveIssue}>Waive Issue</button>
            </>
          )}
        </aside>
      </div>

      <footer className="msg" role="status" aria-live="polite">{msg}</footer>
    </main>
  )
}

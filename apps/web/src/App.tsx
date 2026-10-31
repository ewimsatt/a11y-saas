import { useEffect, useMemo, useRef, useState } from 'react'

type Project = { id: string; name: string; baseUrl: string; _count?: { scans: number } }
type Scan = { id: string; status: string; coverage?: 'PENDING' | 'COMPLETE' | 'PARTIAL' | 'FAILED'; pages?: Array<{ url: string; outcome: 'PENDING' | 'ANALYZED' | 'FAILED'; status?: number | null; error?: string | null }>; startedAt?: string | null; completedAt?: string | null; _count?: { findings: number; pages: number } }
type ScanIssue = { id: string; severity: 'CRITICAL' | 'SERIOUS' | 'MODERATE' | 'MINOR'; impact?: string; status: 'OPEN' | 'FIXED' | 'REGRESSED' | 'WAIVED'; message: string; selector?: string | null; rule?: { id: string; title: string; wcagRefs: string[]; wcagCriteria?: string[] } }
type Evidence = { issueId: string; screenshot: string; domSnippet?: string; meta?: { title?: string; url?: string; failureSummary?: string; help?: string; helpUrl?: string } }

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001'
const POLL_INTERVAL_MS = 2000
const POLL_MAX_ATTEMPTS = 90
const normalizeWcagCriterion = (value: string): string | null => {
  const compact = value.toLowerCase().trim().replace(/^wcag\s*/, '').replace(/[^a-z0-9]/g, '')
  const match = /^([1-4])(\d)(\d)$/.exec(compact)
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null
}
const normalizedCriteria = (refs: string[] | undefined) => [...new Set((refs || []).flatMap((reference) => {
  const criterion = normalizeWcagCriterion(reference)
  return criterion ? [criterion] : []
}))]
const criteriaForRule = (rule: ScanIssue['rule']) => rule?.wcagCriteria?.length ? rule.wcagCriteria : normalizedCriteria(rule?.wcagRefs)

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
  const [waiveAttempted, setWaiveAttempted] = useState(false)
  const [reportFormat, setReportFormat] = useState<'pdf' | 'pptx' | 'html' | 'csv'>('pdf')
  const [msg, setMsg] = useState('')
  const [scansLoading, setScansLoading] = useState(false)
  const [issuesLoading, setIssuesLoading] = useState(false)
  const [evidenceLoading, setEvidenceLoading] = useState(false)
  const [runPending, setRunPending] = useState(false)
  const [waivePending, setWaivePending] = useState(false)
  const projectIdRef = useRef('')
  const scanIdRef = useRef('')
  const selectedIssueRef = useRef<string | null>(null)
  const projectsToken = useRef(0)
  const scansToken = useRef(0)
  const issuesToken = useRef(0)
  const evidenceToken = useRef(0)
  const mutationToken = useRef(0)
  const createToken = useRef(0)
  const runToken = useRef(0)
  const pollToken = useRef(0)

  function clearEvidence() {
    evidenceToken.current += 1
    selectedIssueRef.current = null
    setSelectedIssue(null)
    setEvidence(null)
    setEvidenceLoading(false)
    setWaiveReason('')
    setWaiveAttempted(false)
  }

  function clearScanContext() {
    scansToken.current += 1
    issuesToken.current += 1
    mutationToken.current += 1
    runToken.current += 1
    pollToken.current += 1
    scanIdRef.current = ''
    setScans([])
    setScanId('')
    setIssues([])
    setIssuesLoading(false)
    setRunPending(false)
    setWaivePending(false)
    clearEvidence()
  }

  function applyPreset(preset: 'critical-open' | 'all-open' | 'wcag-131') {
    if (preset === 'critical-open') { setSeverityFilter('CRITICAL'); setStatusFilter('OPEN'); setWcagFilter(''); return }
    if (preset === 'all-open') { setSeverityFilter('ALL'); setStatusFilter('OPEN'); setWcagFilter(''); return }
    setSeverityFilter('ALL'); setStatusFilter('ALL'); setWcagFilter('1.3.1')
  }

  async function loadProjects() {
    const token = ++projectsToken.current
    try {
      const res = await fetch(`${API}/projects`)
      if (!res.ok) throw new Error(res.statusText)
      const data: Project[] = await res.json()
      if (projectsToken.current !== token) return
      setProjects(data)
      if (!projectIdRef.current && data[0]?.id) changeProject(data[0].id)
    } catch (e) {
      if (projectsToken.current === token) setMsg(`Failed to load projects: ${e instanceof Error ? e.message : 'network error'}`)
    }
  }

  async function loadScans(pid: string) {
    const token = ++scansToken.current
    if (!pid) { setScans([]); setScansLoading(false); return }
    setScansLoading(true)
    try {
      const res = await fetch(`${API}/projects/${pid}/scans`)
      if (!res.ok) throw new Error(res.statusText)
      const data = await res.json()
      if (scansToken.current !== token || projectIdRef.current !== pid) return
      setScans(data.scans || [])
    } catch (e) {
      if (scansToken.current === token && projectIdRef.current === pid) setMsg(`Failed to load scans: ${e instanceof Error ? e.message : 'network error'}`)
    } finally {
      if (scansToken.current === token && projectIdRef.current === pid) setScansLoading(false)
    }
  }

  function changeProject(nextProjectId: string) {
    if (nextProjectId === projectIdRef.current) return
    projectIdRef.current = nextProjectId
    clearScanContext()
    setProjectId(nextProjectId)
  }

  function changeScan(nextScanId: string) {
    if (nextScanId === scanIdRef.current) return
    issuesToken.current += 1
    mutationToken.current += 1
    scanIdRef.current = nextScanId
    setScanId(nextScanId)
    setIssues([])
    setIssuesLoading(false)
    setWaivePending(false)
    clearEvidence()
  }

  useEffect(() => { void loadProjects() }, [])
  useEffect(() => { if (projectId) void loadScans(projectId) }, [projectId])
  useEffect(() => () => { pollToken.current += 1; projectsToken.current += 1; scansToken.current += 1; issuesToken.current += 1; evidenceToken.current += 1; mutationToken.current += 1; createToken.current += 1; runToken.current += 1 }, [])

  async function createProject() {
    if (!newProjectName || !newProjectUrl) return
    const token = ++createToken.current
    try {
      const res = await fetch(`${API}/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: newProjectName, baseUrl: newProjectUrl }) })
      if (createToken.current !== token) return
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        if (createToken.current !== token) return
        setMsg(`Create project failed: ${data.error || res.statusText}`)
        return
      }
      setNewProjectName(''); setNewProjectUrl(''); setMsg('Project created')
      if (createToken.current !== token) return
      await loadProjects()
    } catch (e) {
      if (createToken.current === token) setMsg(`Create project failed: ${e instanceof Error ? e.message : 'network error'}`)
    }
  }

  async function loadIssues(id = scanIdRef.current) {
    if (!id || id !== scanIdRef.current) return
    const token = ++issuesToken.current
    clearEvidence()
    setIssues([])
    setIssuesLoading(true)
    try {
      const res = await fetch(`${API}/scans/${id}/issues`)
      if (!res.ok) throw new Error(res.statusText)
      const data = await res.json()
      if (issuesToken.current !== token || scanIdRef.current !== id) return
      setIssues(data.issues || [])
      setMsg(`Loaded ${data.issues?.length || 0} issues`)
    } catch (e) {
      if (issuesToken.current === token && scanIdRef.current === id) setMsg(`Failed to load issues: ${e instanceof Error ? e.message : 'network error'}`)
    } finally {
      if (issuesToken.current === token && scanIdRef.current === id) setIssuesLoading(false)
    }
  }

  async function pollScan(id: string, pid: string) {
    const token = ++pollToken.current
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, POLL_INTERVAL_MS))
      if (pollToken.current !== token || projectIdRef.current !== pid || scanIdRef.current !== id) return
      try {
        const res = await fetch(`${API}/scans/${id}`)
        if (!res.ok) continue
        const scan: Scan = await res.json()
        if (pollToken.current !== token || projectIdRef.current !== pid || scanIdRef.current !== id) return
        if (scan.status === 'completed') {
          const coverage = scan.coverage === 'COMPLETE' ? 'complete coverage' : `${(scan.coverage || 'unknown').toLowerCase()} coverage, not graded`
          setMsg(`Scan completed: ${scan._count?.findings ?? 0} findings, ${coverage}`)
          await loadIssues(id)
          if (pollToken.current !== token || projectIdRef.current !== pid || scanIdRef.current !== id) return
          await loadScans(pid)
          return
        }
        if (scan.status === 'failed') { setMsg('Scan failed — check the worker logs'); await loadScans(pid); return }
        setMsg(`Scan ${scan.status}...`)
      } catch { /* transient network error: keep polling */ }
    }
    if (pollToken.current === token && projectIdRef.current === pid && scanIdRef.current === id) setMsg('Scan is taking a while — use Load Issues to check later')
  }

  async function runScan() {
    const pid = projectIdRef.current
    if (!pid || runPending) return
    const token = ++runToken.current
    setRunPending(true)
    try {
      const res = await fetch(`${API}/scans/${pid}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const data = await res.json()
      if (runToken.current !== token || projectIdRef.current !== pid) return
      if (!res.ok) { setMsg(`Run scan failed: ${data.error || res.statusText}`); return }
      changeScan(data.scanId)
      setMsg(`Scan queued: ${data.scanId}`)
      void pollScan(data.scanId, pid)
    } catch (e) {
      if (runToken.current === token && projectIdRef.current === pid) setMsg(`Run scan failed: ${e instanceof Error ? e.message : 'network error'}`)
    } finally {
      if (runToken.current === token && projectIdRef.current === pid) setRunPending(false)
    }
  }

  async function openEvidence(issue: ScanIssue) {
    const targetScan = scanIdRef.current
    if (!targetScan) return
    const token = ++evidenceToken.current
    selectedIssueRef.current = issue.id
    setSelectedIssue(issue)
    setEvidence(null)
    setEvidenceLoading(true)
    try {
      const res = await fetch(`${API}/issues/${issue.id}/evidence`)
      if (evidenceToken.current !== token || scanIdRef.current !== targetScan || selectedIssueRef.current !== issue.id) return
      if (!res.ok) { setMsg('Failed to load evidence'); return }
      const data: Evidence = await res.json()
      if (evidenceToken.current !== token || scanIdRef.current !== targetScan || selectedIssueRef.current !== issue.id) return
      setEvidence(data)
    } catch {
      if (evidenceToken.current === token && scanIdRef.current === targetScan && selectedIssueRef.current === issue.id) setMsg('Failed to load evidence')
    } finally {
      if (evidenceToken.current === token && scanIdRef.current === targetScan && selectedIssueRef.current === issue.id) setEvidenceLoading(false)
    }
  }

  const waiverInvalid = waiveReason.trim().length < 10
  async function waiveIssue() {
    const issue = selectedIssue
    const targetScan = scanIdRef.current
    if (!issue || !targetScan || waivePending) return
    if (waiverInvalid) { setWaiveAttempted(true); return }
    const token = ++mutationToken.current
    setWaivePending(true)
    try {
      const res = await fetch(`${API}/issues/${issue.id}/waive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: waiveReason.trim() }) })
      if (mutationToken.current !== token || scanIdRef.current !== targetScan || selectedIssueRef.current !== issue.id) return
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        if (mutationToken.current !== token || scanIdRef.current !== targetScan || selectedIssueRef.current !== issue.id) return
        setMsg(`Waive failed: ${data.error || res.statusText}`)
        return
      }
      clearEvidence()
      await loadIssues(targetScan)
      if (mutationToken.current === token && scanIdRef.current === targetScan) setMsg(`Waived issue ${issue.id}`)
    } catch (e) {
      if (mutationToken.current === token && scanIdRef.current === targetScan && selectedIssueRef.current === issue.id) setMsg(`Waive failed: ${e instanceof Error ? e.message : 'network error'}`)
    } finally {
      if (mutationToken.current === token && scanIdRef.current === targetScan) setWaivePending(false)
    }
  }

  const visibleScan = scanId && scans.some((scan) => scan.id === scanId)
  function exportReport() {
    if (!visibleScan) { setMsg('Select a scan to export a report'); return }
    window.open(`${API}/scans/${scanId}/report?format=${reportFormat}`, '_blank', 'noopener')
    setMsg(reportFormat === 'html' ? 'Opening report preview...' : `Downloading ${reportFormat.toUpperCase()} report...`)
  }

  const filtered = useMemo(() => issues.filter((issue) => {
    const requestedCriterion = normalizeWcagCriterion(wcagFilter)
    if (severityFilter !== 'ALL' && issue.severity !== severityFilter) return false
    if (statusFilter !== 'ALL' && issue.status !== statusFilter) return false
    if (wcagFilter && (!requestedCriterion || !criteriaForRule(issue.rule).includes(requestedCriterion))) return false
    return true
  }), [issues, severityFilter, statusFilter, wcagFilter])

  const scanLabel = (scan: Scan) => `${scan.startedAt ? new Date(scan.startedAt).toLocaleString() : 'unknown time'} [${scan.status}${scan.coverage ? `, ${scan.coverage.toLowerCase()}` : ''}]${scan._count ? ` - ${scan._count.findings} findings` : ''}`

  return <main className="app">
    <header><h1>A11Y SaaS - Issues Console</h1><p>Projects, scans, issue triage, evidence, and waivers.</p></header>
    <section className="panel controls" aria-labelledby="project-scan-heading">
      <h2 id="project-scan-heading">Project + Scan</h2>
      <div className="row">
        <select aria-label="Project" value={projectId} onChange={(event) => changeProject(event.target.value)}><option value="">Select project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
        <button onClick={runScan} disabled={!projectId || runPending}>{runPending ? 'Queueing Scan…' : 'Run Scan'}</button>
        <select aria-label="Scan" value={visibleScan ? scanId : ''} onChange={(event) => changeScan(event.target.value)} disabled={scansLoading}><option value="">{scansLoading ? 'Loading scans…' : 'Select scan'}</option>{scans.map((scan) => <option key={scan.id} value={scan.id}>{scanLabel(scan)}</option>)}</select>
        <button onClick={() => void loadIssues()} disabled={!visibleScan || issuesLoading}>{issuesLoading ? 'Loading Issues…' : 'Load Issues'}</button>
      </div>
      <div className="row"><input aria-label="New project name" value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="New project name" /><input aria-label="New project base URL" value={newProjectUrl} onChange={(event) => setNewProjectUrl(event.target.value)} placeholder="https://example.com" /><button onClick={createProject}>Create Project</button></div>
      <div className="row"><select aria-label="Report format" value={reportFormat} onChange={(event) => setReportFormat(event.target.value as 'pdf' | 'pptx' | 'html' | 'csv')}><option value="pdf">PDF technical document</option><option value="pptx">Executive slide deck (PowerPoint)</option><option value="csv">Full findings CSV</option><option value="html">HTML preview</option></select><button onClick={exportReport} disabled={!visibleScan}>Export Report</button></div>
    </section>
    <div className="grid">
      <section className="panel" aria-labelledby="issues-heading"><h2 id="issues-heading">Issues</h2>
        <div className="row"><select aria-label="Filter by severity" value={severityFilter} onChange={(event) => setSeverityFilter(event.target.value)}><option>ALL</option><option>CRITICAL</option><option>SERIOUS</option><option>MODERATE</option><option>MINOR</option></select><select aria-label="Filter by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option>ALL</option><option>OPEN</option><option>FIXED</option><option>REGRESSED</option><option>WAIVED</option></select><input aria-label="Filter by WCAG reference" value={wcagFilter} onChange={(event) => setWcagFilter(event.target.value)} placeholder="WCAG contains (e.g. 1.3.1)" /></div>
        <div className="row"><button className="ghost" onClick={() => applyPreset('critical-open')}>Preset: Critical + Open</button><button className="ghost" onClick={() => applyPreset('all-open')}>Preset: All Open</button><button className="ghost" onClick={() => applyPreset('wcag-131')}>Preset: WCAG 1.3.1</button></div>
        {issuesLoading && <p role="status">Loading issues…</p>}
        <table><thead><tr><th scope="col">Severity</th><th scope="col">Status</th><th scope="col">WCAG</th><th scope="col">Message</th><th scope="col"><span className="visually-hidden">Evidence</span></th></tr></thead><tbody>{filtered.map((issue) => <tr key={issue.id} onClick={() => void openEvidence(issue)} className={selectedIssue?.id === issue.id ? 'active' : ''}><td>{issue.severity}</td><td>{issue.status}</td><td>{criteriaForRule(issue.rule).join(', ') || '-'}</td><td>{issue.message}</td><td><button className="ghost" onClick={(event) => { event.stopPropagation(); void openEvidence(issue) }} aria-label={`View evidence for ${issue.severity.toLowerCase()} issue: ${issue.message}`}>View</button></td></tr>)}</tbody></table>
      </section>
      <aside className="panel" aria-labelledby="evidence-heading"><h2 id="evidence-heading">Evidence</h2>{!selectedIssue && <p>Select an issue to load evidence.</p>}{selectedIssue && <><p><strong>Issue:</strong> {selectedIssue.id}</p>{selectedIssue.rule && <p><strong>Rule:</strong> {selectedIssue.rule.id} — {selectedIssue.rule.title}</p>}<p><strong>Impact:</strong> {selectedIssue.impact || selectedIssue.severity.toLowerCase()}</p>{evidenceLoading && <p role="status">Loading evidence…</p>}{evidence?.meta?.url && <p><strong>URL:</strong> {evidence.meta.url}</p>}{evidence?.screenshot && <img src={`${API}${evidence.screenshot}`} alt={evidence.meta?.title ? `Full-page screenshot of ${evidence.meta.title}` : 'Full-page screenshot of the scanned page'} className="shot" />}{evidence?.meta?.failureSummary && <p>{evidence.meta.failureSummary}</p>}{evidence?.meta?.help && <p><strong>How to fix:</strong> {evidence.meta.help}</p>}{evidence?.meta?.helpUrl && <p><a href={evidence.meta.helpUrl} target="_blank" rel="noreferrer" aria-label="Axe rule help source">Axe rule help source</a></p>}<p className="limitation">Automated findings are remediation guidance, not a compliance determination.</p><pre>{evidence?.domSnippet || selectedIssue.selector || 'No DOM snippet available.'}</pre><h3 id="waive-heading">Waive</h3><textarea aria-label="Waive reason" aria-describedby={(waiveAttempted || waiveReason.length > 0) && waiverInvalid ? 'waive-error' : undefined} value={waiveReason} onChange={(event) => setWaiveReason(event.target.value)} placeholder="Reason (min 10 chars)" minLength={10} rows={4} />{(waiveAttempted || waiveReason.length > 0) && waiverInvalid && <p id="waive-error" role="alert">Enter at least 10 characters to waive this issue.</p>}<button onClick={waiveIssue} disabled={waiverInvalid || waivePending}>Waive Issue</button></>}</aside>
    </div>
    <footer className="msg" role="status" aria-live="polite">{msg}</footer>
  </main>
}

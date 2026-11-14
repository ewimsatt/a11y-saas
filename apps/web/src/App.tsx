import { useEffect, useMemo, useRef, useState } from 'react'

type Project = { id: string; name: string; baseUrl: string; _count?: { scans: number } }
type Scan = { id: string; status: string; coverage?: 'PENDING' | 'COMPLETE' | 'PARTIAL' | 'FAILED'; pages?: Array<{ url: string; outcome: 'PENDING' | 'ANALYZED' | 'FAILED'; status?: number | null; error?: string | null }>; startedAt?: string | null; completedAt?: string | null; _count?: { findings: number; pages: number } }
type ScanIssue = { id: string; severity: 'CRITICAL' | 'SERIOUS' | 'MODERATE' | 'MINOR'; impact?: string; status: 'OPEN' | 'FIXED' | 'REGRESSED' | 'WAIVED'; message: string; selector?: string | null; waivedReason?: string | null; waivedExpiresAt?: string | null; rule?: { id: string; title: string; wcagRefs: string[]; wcagCriteria?: string[] } }
type FixedTransition = { priorFindingId: string; priorEvidenceId: string | null; priorPageUrl: string; ruleId: string; message: string }
type ScanComparison = { prevScanId: string; fixed: FixedTransition[] }
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
  const [comparison, setComparison] = useState<ScanComparison | null>(null)
  const [issuesResolved, setIssuesResolved] = useState(false)
  const [selectedIssue, setSelectedIssue] = useState<ScanIssue | null>(null)
  const [historicalEvidence, setHistoricalEvidence] = useState<FixedTransition | null>(null)
  const [evidence, setEvidence] = useState<Evidence | null>(null)
  const [severityFilter, setSeverityFilter] = useState('ALL')
  const [statusFilter, setStatusFilter] = useState('ALL')
  const [wcagFilter, setWcagFilter] = useState('')
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectUrl, setNewProjectUrl] = useState('')
  const [waiveReason, setWaiveReason] = useState('')
  const [waiveExpiresAt, setWaiveExpiresAt] = useState('')
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
    setHistoricalEvidence(null)
    setEvidence(null)
    setEvidenceLoading(false)
    setWaiveReason('')
    setWaiveExpiresAt('')
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
    setComparison(null)
    setIssuesResolved(false)
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
    setComparison(null)
    setIssuesResolved(false)
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
    setComparison(null)
    setIssuesResolved(false)
    setIssuesLoading(true)
    try {
      const res = await fetch(`${API}/scans/${id}/issues`)
      if (!res.ok) throw new Error(res.statusText)
      const data = await res.json()
      if (issuesToken.current !== token || scanIdRef.current !== id) return
      setIssues(data.issues || [])
      setComparison(data.comparison || null)
      setIssuesResolved(true)
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
        if (scan.status === 'failed') { setMsg('Scan failed. Check the worker logs.'); await loadScans(pid); return }
        setMsg(`Scan ${scan.status}...`)
      } catch { /* transient network error: keep polling */ }
    }
    if (pollToken.current === token && projectIdRef.current === pid && scanIdRef.current === id) setMsg('Scan is taking a while. Use Load findings to check later')
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
    setHistoricalEvidence(null)
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

  async function openFixedEvidence(transition: FixedTransition) {
    const targetScan = scanIdRef.current
    if (!targetScan) return
    const token = ++evidenceToken.current
    selectedIssueRef.current = transition.priorFindingId
    setSelectedIssue(null)
    setHistoricalEvidence(transition)
    setEvidence(null)
    setEvidenceLoading(true)
    try {
      const res = await fetch(`${API}/issues/${transition.priorFindingId}/evidence`)
      if (evidenceToken.current !== token || scanIdRef.current !== targetScan || selectedIssueRef.current !== transition.priorFindingId) return
      if (!res.ok) { setMsg('Failed to load historical evidence'); return }
      const data: Evidence = await res.json()
      if (evidenceToken.current !== token || scanIdRef.current !== targetScan || selectedIssueRef.current !== transition.priorFindingId) return
      setEvidence(data)
    } catch {
      if (evidenceToken.current === token && scanIdRef.current === targetScan && selectedIssueRef.current === transition.priorFindingId) setMsg('Failed to load historical evidence')
    } finally {
      if (evidenceToken.current === token && scanIdRef.current === targetScan && selectedIssueRef.current === transition.priorFindingId) setEvidenceLoading(false)
    }
  }

  const waiverExpiryInvalid = waiveExpiresAt !== '' && (!Number.isFinite(Date.parse(waiveExpiresAt)) || new Date(waiveExpiresAt) <= new Date())
  const waiverInvalid = waiveReason.trim().length < 10 || waiverExpiryInvalid
  async function waiveIssue() {
    const issue = selectedIssue
    const targetScan = scanIdRef.current
    if (!issue || !targetScan || waivePending) return
    const expiryInvalidNow = waiveExpiresAt !== '' && (!Number.isFinite(Date.parse(waiveExpiresAt)) || new Date(waiveExpiresAt) <= new Date())
    if (waiveReason.trim().length < 10 || expiryInvalidNow) { setWaiveAttempted(true); return }
    const token = ++mutationToken.current
    setWaivePending(true)
    try {
      const payload = { reason: waiveReason.trim(), ...(waiveExpiresAt ? { expiresAt: new Date(waiveExpiresAt).toISOString() } : {}) }
      const res = await fetch(`${API}/issues/${issue.id}/waive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
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

  async function unwaiveIssue() {
    const issue = selectedIssue
    const targetScan = scanIdRef.current
    if (!issue || issue.status !== 'WAIVED' || !targetScan || waivePending) return
    const token = ++mutationToken.current
    setWaivePending(true)
    try {
      const res = await fetch(`${API}/issues/${issue.id}/unwaive`, { method: 'POST' })
      if (mutationToken.current !== token || scanIdRef.current !== targetScan || selectedIssueRef.current !== issue.id) return
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setMsg(`Unwaive failed: ${data.error || res.statusText}`)
        return
      }
      clearEvidence()
      await loadIssues(targetScan)
      if (mutationToken.current === token && scanIdRef.current === targetScan) setMsg(`Unwaived issue ${issue.id}`)
    } catch (e) {
      if (mutationToken.current === token && scanIdRef.current === targetScan && selectedIssueRef.current === issue.id) setMsg(`Unwaive failed: ${e instanceof Error ? e.message : 'network error'}`)
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

  const selectedScan = scans.find((scan) => scan.id === scanId)
  const coverageLabel = selectedScan?.coverage ? `${selectedScan.coverage.toLowerCase()} coverage` : 'coverage pending'
  const resetFilters = () => { setSeverityFilter('ALL'); setStatusFilter('ALL'); setWcagFilter('') }

  return <main className="app">
    <header className="site-header">
      <div className="brand"><span className="brand-mark" aria-hidden="true">P</span><div><p className="eyebrow">Propellic</p><h1>Propellic Accessibility</h1></div></div>
      <p className="workspace-context">Local workspace <span aria-hidden="true">•</span> projects, scan review, evidence, and waivers</p>
    </header>

    <section className="workspace panel" aria-labelledby="workspace-heading">
      <div className="section-heading"><div><p className="eyebrow">Workspace</p><h2 id="workspace-heading">Choose what to review</h2></div><p className="helper">Select a project and scan, then load its findings.</p></div>
      <div className="workspace-grid">
        <label>Project<select aria-label="Project" value={projectId} onChange={(event) => changeProject(event.target.value)}><option value="">Select project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <label>Scan<select aria-label="Scan" value={visibleScan ? scanId : ''} onChange={(event) => changeScan(event.target.value)} disabled={scansLoading}><option value="">{scansLoading ? 'Loading scans…' : 'Select scan'}</option>{scans.map((scan) => <option key={scan.id} value={scan.id}>{scanLabel(scan)}</option>)}</select></label>
        <div className="primary-action"><button className="primary" onClick={runScan} disabled={!projectId || runPending}>{runPending ? 'Queueing scan…' : 'Run scan'}</button><button className="secondary" onClick={() => void loadIssues()} disabled={!visibleScan || issuesLoading}>{issuesLoading ? 'Loading findings…' : 'Load findings'}</button></div>
      </div>
      <div className="workspace-support">
        <details><summary>Create a project</summary><div className="create-project"><label>Project name<input aria-label="New project name" value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} placeholder="Example: AncientTravel" /></label><label>Website URL<input aria-label="New project base URL" value={newProjectUrl} onChange={(event) => setNewProjectUrl(event.target.value)} placeholder="https://example.com" /></label><button className="secondary" onClick={createProject}>Create project</button></div></details>
        <div className="export-tools"><label>Export format<select aria-label="Report format" value={reportFormat} onChange={(event) => setReportFormat(event.target.value as 'pdf' | 'pptx' | 'html' | 'csv')}><option value="pdf">PDF technical document</option><option value="pptx">Executive slide deck (PowerPoint)</option><option value="csv">Full findings CSV</option><option value="html">HTML preview</option></select></label><button className="secondary" onClick={exportReport} disabled={!visibleScan}>Export report</button></div>
      </div>
    </section>

    <section className="scan-summary" aria-label="Selected scan summary">
      <div><span className="summary-label">Current scan</span><strong>{selectedScan ? new Date(selectedScan.startedAt || Date.now()).toLocaleString() : 'No scan selected'}</strong></div>
      <div><span className="summary-label">Findings</span><strong>{selectedScan?._count?.findings ?? (issuesResolved ? issues.length : 'Not loaded')}</strong></div>
      <div><span className="summary-label">Coverage</span><span className={`status-badge coverage-${selectedScan?.coverage?.toLowerCase() || 'pending'}`}>{coverageLabel}</span></div>
      {issuesResolved && <div><span className="summary-label">Shown</span><strong>{filtered.length} of {issues.length}</strong></div>}
    </section>

    <div className="review-grid">
      <section className="panel findings" aria-labelledby="issues-heading">
        <div className="section-heading"><div><p className="eyebrow">Findings</p><h2 id="issues-heading">Issues to review</h2></div>{issuesResolved && <p className="helper">{filtered.length} shown of {issues.length} loaded</p>}</div>
        <div className="filter-grid">
          <label>Severity<select aria-label="Filter by severity" value={severityFilter} onChange={(event) => setSeverityFilter(event.target.value)}><option>ALL</option><option>CRITICAL</option><option>SERIOUS</option><option>MODERATE</option><option>MINOR</option></select></label>
          <label>Status<select aria-label="Filter by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option>ALL</option><option>OPEN</option><option>REGRESSED</option><option>WAIVED</option></select></label>
          <label>WCAG criterion<input aria-label="Filter by WCAG reference" value={wcagFilter} onChange={(event) => setWcagFilter(event.target.value)} placeholder="Example: 1.3.1" /></label>
          <button className="secondary reset" onClick={resetFilters} disabled={severityFilter === 'ALL' && statusFilter === 'ALL' && !wcagFilter}>Reset filters</button>
        </div>
        <div className="preset-row"><button className="chip" onClick={() => applyPreset('critical-open')}>Critical + open</button><button className="chip" onClick={() => applyPreset('all-open')}>All open</button><button className="chip" onClick={() => applyPreset('wcag-131')}>WCAG 1.3.1</button></div>
        {issuesLoading && <p className="state" role="status">Loading findings…</p>}
        {!issuesLoading && !issuesResolved && <p className="state">Choose a scan and load findings to begin review.</p>}
        {!issuesLoading && issuesResolved && issues.length === 0 && <p className="state" role="status">No issues found for this scan.</p>}
        {!issuesLoading && issuesResolved && issues.length > 0 && filtered.length === 0 && <p className="state">No findings match these filters. Reset filters to view all loaded findings.</p>}
        {comparison?.fixed.length ? <section className="history" aria-labelledby="comparison-heading"><h3 id="comparison-heading">Resolved since the comparable scan</h3><p>{comparison.fixed.length} historical transition{comparison.fixed.length === 1 ? '' : 's'} are separate from current findings.</p><ul>{comparison.fixed.map((transition) => <li key={transition.priorFindingId}><strong>{transition.ruleId}</strong><span>{transition.message}</span><button className="text-button" onClick={() => openFixedEvidence(transition)} aria-label={`View prior evidence for ${transition.ruleId}`}>View prior evidence</button></li>)}</ul></section> : null}
        <div className="findings-list" aria-live="polite">{filtered.map((issue) => <article key={issue.id} className={`finding ${selectedIssue?.id === issue.id ? 'active' : ''}`}><button className="finding-main" onClick={() => void openEvidence(issue)} aria-label={`Open evidence for ${issue.severity.toLowerCase()} issue: ${issue.message}`}><span className={`severity-badge severity-${issue.severity.toLowerCase()}`}>{issue.severity.toLowerCase()}</span><span className={`status-badge status-${issue.status.toLowerCase()}`}>{issue.status.toLowerCase()}</span><span className="finding-copy"><strong>{issue.rule?.title || issue.rule?.id || 'Accessibility finding'}</strong><span>{issue.message}</span><small>{criteriaForRule(issue.rule).join(', ') || 'No WCAG criterion recorded'}</small></span></button><button className="secondary evidence-button" onClick={() => void openEvidence(issue)}>Evidence</button></article>)}</div>
      </section>

      <aside className="panel evidence-panel" aria-labelledby="evidence-heading">
        <div className="section-heading"><div><p className="eyebrow">Evidence</p><h2 id="evidence-heading">{historicalEvidence ? 'Historical evidence' : 'Selected finding'}</h2></div></div>
        {!selectedIssue && !historicalEvidence && <p className="state">Select a finding to inspect its page context, screenshot, and remediation guidance.</p>}
        {historicalEvidence && <div className="evidence-meta"><p><strong>Previous observation</strong><span>{historicalEvidence.priorFindingId}</span></p><p><strong>Rule</strong><span>{historicalEvidence.ruleId}</span></p><p><strong>Prior URL</strong><a href={historicalEvidence.priorPageUrl} target="_blank" rel="noreferrer">{historicalEvidence.priorPageUrl}</a></p><p><strong>Message</strong><span>{historicalEvidence.message}</span></p></div>}
        {selectedIssue && <div className="evidence-meta"><p><strong>{selectedIssue.rule?.title || 'Accessibility finding'}</strong><span>{selectedIssue.rule?.id || selectedIssue.id}</span></p><p><strong>Impact</strong><span className={`severity-badge severity-${selectedIssue.severity.toLowerCase()}`}>{selectedIssue.impact || selectedIssue.severity.toLowerCase()}</span></p><p><strong>Status</strong><span className={`status-badge status-${selectedIssue.status.toLowerCase()}`}>{selectedIssue.status.toLowerCase()}</span></p></div>}
        {evidenceLoading && <p className="state" role="status">Loading evidence…</p>}
        {evidence?.meta?.url && <p className="evidence-url"><strong>Page</strong><a href={evidence.meta.url} target="_blank" rel="noreferrer">{evidence.meta.url}</a></p>}
        {evidence?.screenshot && <a className="screenshot-link" href={`${API}${evidence.screenshot}`} target="_blank" rel="noreferrer" aria-label="Open full-size evidence screenshot"><img src={`${API}${evidence.screenshot}`} alt={evidence.meta?.title ? `Full-page screenshot of ${evidence.meta.title}` : 'Full-page screenshot of the scanned page'} className="shot" /></a>}
        {evidence?.meta?.failureSummary && <p className="failure-summary">{evidence.meta.failureSummary}</p>}
        {evidence?.meta?.help && <p className="remediation"><strong>How to fix</strong>{evidence.meta.help}</p>}
        {evidence?.meta?.helpUrl && <p><a href={evidence.meta.helpUrl} target="_blank" rel="noreferrer" aria-label="Axe rule help source">Read Axe rule help</a></p>}
        {(selectedIssue || historicalEvidence) && <details className="technical"><summary>Technical details</summary><pre>{evidence?.domSnippet || 'No DOM snippet available.'}</pre></details>}
        {selectedIssue && <div className="waiver-panel">{selectedIssue.status === 'WAIVED' ? <><p><strong>Waiver reason:</strong> {selectedIssue.waivedReason || 'No reason recorded.'}</p><p><strong>Waiver expiry:</strong> {selectedIssue.waivedExpiresAt ? new Date(selectedIssue.waivedExpiresAt).toLocaleString() : 'No expiry'}</p><button className="secondary" onClick={unwaiveIssue} disabled={waivePending}>{waivePending ? 'Updating waiver…' : 'Unwaive issue'}</button></> : <><label>Waive reason<textarea aria-label="Waive reason" value={waiveReason} onChange={(event) => { setWaiveReason(event.target.value); setWaiveAttempted(true) }} placeholder="Explain why this finding is accepted" /></label><label>Waiver expiry (optional)<input aria-label="Waiver expiry (optional)" type="datetime-local" value={waiveExpiresAt} onChange={(event) => { setWaiveExpiresAt(event.target.value); setWaiveAttempted(true) }} /></label>{(waiveAttempted || waiveReason.length > 0 || waiveExpiresAt.length > 0) && waiverInvalid && <p className="field-error" role="alert">{waiveReason.trim().length < 10 ? 'Enter at least 10 characters to waive this issue.' : 'Choose a future waiver expiry or leave it blank.'}</p>}<button className="secondary" onClick={waiveIssue} disabled={waiverInvalid || waivePending}>{waivePending ? 'Updating waiver…' : 'Waive issue'}</button></>}</div>}
        {(selectedIssue || historicalEvidence) && <p className="limitation">Automated findings are remediation guidance, not a compliance determination.</p>}
      </aside>
    </div>
    <div className="msg" role="status" aria-live="polite">{msg}</div>
  </main>
}

import type { ReportData, ReportFinding } from './data';
import { SEVERITY_ORDER, STATUS_ORDER, type Severity } from './stats';

const SEVERITY_COLORS: Record<Severity, string> = {
  CRITICAL: '#b91c1c',
  SERIOUS: '#c2410c',
  MODERATE: '#a16207',
  MINOR: '#0369a1'
};

const STATUS_COLORS: Record<string, string> = {
  OPEN: '#b91c1c',
  REGRESSED: '#c2410c',
  FIXED: '#15803d',
  WAIVED: '#64748b'
};

function esc(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return '—';
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function severityBadge(severity: Severity): string {
  return `<span class="badge" style="background:${SEVERITY_COLORS[severity]}">${severity}</span>`;
}

function barChart(entries: Array<{ label: string; count: number; color: string }>): string {
  const max = Math.max(1, ...entries.map((e) => e.count));
  return `<div class="bars">${entries
    .map(
      (e) => `
    <div class="bar-row">
      <span class="bar-label">${esc(e.label)}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${Math.max(
        2,
        Math.round((e.count / max) * 100)
      )}%;background:${e.color}"></span></span>
      <span class="bar-count">${e.count}</span>
    </div>`
    )
    .join('')}</div>`;
}

function findingCard(f: ReportFinding): string {
  return `
  <div class="finding">
    <div class="finding-head">
      ${severityBadge(f.severity)}
      <span class="badge badge-status" style="background:${STATUS_COLORS[f.status] ?? '#64748b'}">${f.status}</span>
      <code class="rule-id">${esc(f.ruleId)}</code>
    </div>
    <p class="finding-message">${esc(f.message)}</p>
    <p class="finding-url">${esc(f.pageUrl)}</p>
    ${f.failureSummary ? `<p class="finding-summary">${esc(f.failureSummary)}</p>` : ''}
    ${f.domSnippet || f.selector ? `<pre class="snippet">${esc(f.domSnippet || f.selector)}</pre>` : ''}
  </div>`;
}

export function renderReportHtml(data: ReportData): string {
  const { totals } = data;
  const severityEntries = SEVERITY_ORDER.map((s) => ({
    label: s,
    count: totals.bySeverity[s],
    color: SEVERITY_COLORS[s]
  }));
  const statusEntries = STATUS_ORDER.map((s) => ({
    label: s,
    count: totals.byStatus[s],
    color: STATUS_COLORS[s] ?? '#64748b'
  }));

  const comparisonSection = data.comparison
    ? `
  <section class="section">
    <h2>Change Since Previous Scan</h2>
    <div class="kpis kpis-3">
      <div class="kpi"><div class="kpi-value good">${data.comparison.fixed}</div><div class="kpi-label">Fixed</div></div>
      <div class="kpi"><div class="kpi-value bad">${data.comparison.regressed}</div><div class="kpi-label">Regressed</div></div>
      <div class="kpi"><div class="kpi-value">${data.comparison.prevTotal} → ${totals.findings}</div><div class="kpi-label">Total findings</div></div>
    </div>
    <p class="muted">Compared against the scan completed ${fmtDate(data.comparison.prevCompletedAt)}.</p>
  </section>`
    : '';

  const screenshotPages = data.pages.filter((p) => p.screenshotBase64);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Accessibility Report — ${esc(data.project.name)}</title>
<style>
  :root { --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --accent:#0e7490; --paper:#ffffff; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: Inter, 'Helvetica Neue', Arial, sans-serif; color:var(--ink); background:var(--paper); font-size:14px; line-height:1.5; }
  .page { max-width: 880px; margin: 0 auto; padding: 40px; }
  .cover { border-bottom: 4px solid var(--accent); padding-bottom: 28px; margin-bottom: 28px; }
  .cover .eyebrow { color: var(--accent); font-weight: 700; letter-spacing: .12em; text-transform: uppercase; font-size: 12px; margin: 0 0 8px; }
  .cover h1 { font-size: 34px; margin: 0 0 6px; }
  .cover .target { font-size: 16px; color: var(--muted); margin: 0 0 16px; word-break: break-all; }
  .cover-meta { display:flex; gap:32px; flex-wrap:wrap; color:var(--muted); font-size:13px; }
  .cover-meta strong { color: var(--ink); display:block; font-size:14px; }
  .section { margin-bottom: 32px; break-inside: avoid; }
  .section > h2 { font-size: 20px; border-bottom: 2px solid var(--line); padding-bottom: 6px; margin: 0 0 16px; }
  .kpis { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
  .kpis-3 { grid-template-columns: repeat(3, 1fr); }
  .kpi { border: 1px solid var(--line); border-radius: 10px; padding: 14px; text-align: center; background:#f8fafc; }
  .kpi-value { font-size: 28px; font-weight: 800; }
  .kpi-value.good { color: #15803d; }
  .kpi-value.bad { color: #b91c1c; }
  .kpi-label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin-top: 4px; }
  .score-ring { font-size: 40px; font-weight: 800; color: var(--accent); }
  .grade { font-size: 16px; color: var(--muted); font-weight: 600; }
  .bars { display: flex; flex-direction: column; gap: 8px; }
  .bar-row { display: grid; grid-template-columns: 110px 1fr 48px; align-items: center; gap: 10px; }
  .bar-label { font-size: 12px; font-weight: 700; letter-spacing: .04em; }
  .bar-track { background: #f1f5f9; border-radius: 6px; height: 18px; overflow: hidden; }
  .bar-fill { display: block; height: 100%; border-radius: 6px; }
  .bar-count { text-align: right; font-weight: 700; }
  .charts { display:grid; grid-template-columns: 1fr 1fr; gap: 32px; }
  .charts h3 { margin: 0 0 12px; font-size: 14px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { background:#f8fafc; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  .badge { display:inline-block; color:#fff; font-size:11px; font-weight:700; padding:2px 8px; border-radius:999px; letter-spacing:.04em; }
  .rule-id { color: var(--muted); font-size: 12px; }
  .finding { border:1px solid var(--line); border-left:4px solid var(--accent); border-radius:8px; padding:12px 14px; margin-bottom:10px; break-inside: avoid; }
  .finding-head { display:flex; align-items:center; gap:8px; margin-bottom:6px; }
  .finding-message { margin: 0 0 4px; font-weight: 600; }
  .finding-url { margin: 0 0 6px; color: var(--muted); font-size: 12px; word-break: break-all; }
  .finding-summary { margin: 0 0 6px; font-size: 13px; }
  .snippet { background:#f8fafc; border:1px solid var(--line); border-radius:6px; padding:8px 10px; font-size:12px; overflow-wrap:anywhere; white-space:pre-wrap; margin:0; }
  .muted { color: var(--muted); font-size: 13px; }
  .omitted { color: var(--muted); font-style: italic; margin: 4px 0 16px; }
  .shots { display:grid; grid-template-columns: 1fr 1fr; gap:16px; }
  .shot-card { border:1px solid var(--line); border-radius:10px; overflow:hidden; break-inside: avoid; }
  .shot-card img { width:100%; max-height:300px; object-fit:cover; object-position:top; display:block; }
  .shot-card figcaption { padding:8px 12px; font-size:12px; color:var(--muted); word-break:break-all; }
  footer { border-top: 2px solid var(--line); margin-top: 40px; padding-top: 16px; color: var(--muted); font-size: 12px; }
  @page { size: A4; margin: 14mm 12mm; }
  @media print {
    .page { padding: 0; max-width: none; }
    .section { page-break-inside: auto; }
    .finding, .shot-card, .kpi { page-break-inside: avoid; }
  }
</style>
</head>
<body>
<div class="page">
  <header class="cover">
    <p class="eyebrow">Accessibility Audit Report</p>
    <h1>${esc(data.project.name)}</h1>
    <p class="target">${esc(data.project.baseUrl)}</p>
    <div class="cover-meta">
      <div><strong>${fmtDate(data.scan.startedAt)}</strong>Scan started</div>
      <div><strong>${fmtDate(data.scan.completedAt)}</strong>Scan completed</div>
      <div><strong>${esc(data.scan.status)}</strong>Scan status</div>
      <div><strong>${fmtDate(data.generatedAt)}</strong>Report generated</div>
    </div>
  </header>

  <section class="section">
    <h2>Executive Summary</h2>
    <div class="kpis">
      <div class="kpi"><div class="score-ring">${data.score}</div><div class="kpi-label">Score <span class="grade">(${data.grade})</span></div></div>
      <div class="kpi"><div class="kpi-value">${totals.findings}</div><div class="kpi-label">Total findings</div></div>
      <div class="kpi"><div class="kpi-value bad">${totals.bySeverity.CRITICAL}</div><div class="kpi-label">Critical</div></div>
      <div class="kpi"><div class="kpi-value">${totals.byStatus.OPEN + totals.byStatus.REGRESSED}</div><div class="kpi-label">Needs action</div></div>
      <div class="kpi"><div class="kpi-value">${data.pages.filter((p) => p.crawled).length}/${data.pages.length}</div><div class="kpi-label">Pages scanned</div></div>
    </div>
  </section>

  <section class="section">
    <h2>Findings Breakdown</h2>
    <div class="charts">
      <div><h3>By severity</h3>${barChart(severityEntries)}</div>
      <div><h3>By status</h3>${barChart(statusEntries)}</div>
    </div>
  </section>
  ${comparisonSection}

  <section class="section">
    <h2>Most Frequent Rules</h2>
    ${
      data.topRules.length
        ? `<table>
      <thead><tr><th>Rule</th><th>WCAG</th><th>Max severity</th><th>Count</th></tr></thead>
      <tbody>
        ${data.topRules
          .map(
            (r) => `<tr>
          <td><strong>${esc(r.ruleId)}</strong><br><span class="muted">${esc(r.title)}</span></td>
          <td>${esc(r.wcagRefs.join(', ') || '—')}</td>
          <td>${severityBadge(r.maxSeverity)}</td>
          <td>${r.count}</td>
        </tr>`
          )
          .join('')}
      </tbody>
    </table>`
        : '<p class="muted">No findings recorded for this scan.</p>'
    }
  </section>

  ${data.findingsBySeverity
    .map(
      (group) => `
  <section class="section">
    <h2>${group.severity.charAt(0) + group.severity.slice(1).toLowerCase()} Findings (${
        group.findings.length + group.omitted
      })</h2>
    ${group.findings.map(findingCard).join('')}
    ${group.omitted ? `<p class="omitted">…and ${group.omitted} more ${group.severity.toLowerCase()} findings not shown.</p>` : ''}
  </section>`
    )
    .join('')}

  <section class="section">
    <h2>Pages</h2>
    <table>
      <thead><tr><th>URL</th><th>Title</th><th>Crawled</th><th>Findings</th></tr></thead>
      <tbody>
        ${data.pages
          .map(
            (p) => `<tr>
          <td>${esc(p.url)}</td>
          <td>${esc(p.title ?? '—')}</td>
          <td>${p.crawled ? 'Yes' : 'Failed'}</td>
          <td>${p.findingCount}</td>
        </tr>`
          )
          .join('')}
      </tbody>
    </table>
  </section>

  ${
    screenshotPages.length
      ? `<section class="section">
    <h2>Page Screenshots</h2>
    <div class="shots">
      ${screenshotPages
        .map(
          (p) => `<figure class="shot-card">
        <img src="data:image/png;base64,${p.screenshotBase64}" alt="Screenshot of ${esc(p.title ?? p.url)}">
        <figcaption>${esc(p.title ?? '')} — ${esc(p.url)}</figcaption>
      </figure>`
        )
        .join('')}
    </div>
  </section>`
      : ''
  }

  <footer>
    <p><strong>Methodology.</strong> Pages were loaded in headless Chromium and evaluated with axe-core against WCAG 2.0/2.1 A and AA rules. Findings are fingerprinted for stable tracking across scans; waived findings are excluded from the health score.</p>
    <p><strong>Disclaimer.</strong> Automated scanning detects a subset of accessibility issues and does not by itself establish legal compliance. Manual expert review remains essential.</p>
    <p>Scan ${esc(data.scan.id)} · Generated by A11Y SaaS</p>
  </footer>
</div>
</body>
</html>`;
}

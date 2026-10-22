import type { ReportData, ReportFinding } from './data';
import { publicFailureReason } from '@a11y/shared';
import { groupContrastPatterns } from './contrast';
import { SEVERITY_ORDER, STATUS_ORDER, type Severity } from './stats';
import { findingGuidance } from './quality';
import { selectRepresentativeFindings } from './representatives';

const severityColor: Record<Severity, string> = {
  CRITICAL: '#8b1e1e',
  SERIOUS: '#913b00',
  MODERATE: '#6b5100',
  MINOR: '#075d86'
};
const statusColor: Record<string, string> = {
  OPEN: '#8b1e1e',
  REGRESSED: '#913b00',
  FIXED: '#176b43',
  WAIVED: '#46545c'
};

function esc(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmt(date: Date | null | undefined): string {
  return date
    ? `${date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`
    : 'Not recorded';
}

function short(value: string | null, max = 280): string {
  return !value ? '' : value.length > max ? `${value.slice(0, max)}… (full value in CSV)` : value;
}

function badge(value: string, color: string): string {
  return `<span class="badge" style="background:${color}">${esc(value)}</span>`;
}

function bars(entries: Array<{ label: string; value: number; color: string }>): string {
  const max = Math.max(1, ...entries.map((entry) => entry.value));
  return `<div class="bars">${entries
    .map(
      (entry) => `<div class="bar"><span>${esc(entry.label)}</span><i><b style="width:${Math.round(
        (entry.value / max) * 100
      )}%;background:${entry.color}"></b></i><strong>${entry.value}</strong></div>`
    )
    .join('')}</div>`;
}

function evidence(finding: ReportFinding): string {
  const guidance = findingGuidance(finding.ruleId);
  return `<article class="evidence">
    <div>${badge(finding.severity, severityColor[finding.severity])}${badge(
      finding.status,
      statusColor[finding.status] ?? '#46545c'
    )}<code>${esc(finding.ruleId)}</code></div>
    <h3>${esc(finding.message)}</h3>
    <p class="muted"><b>Finding ID:</b> ${esc(finding.id)}<br><b>URL:</b> ${esc(finding.pageUrl)}</p>
    ${finding.selector ? `<p><b>Selector:</b> <code>${esc(short(finding.selector, 180))}</code></p>` : ''}
    ${finding.failureSummary ? `<p><b>Observed failure:</b> ${esc(short(finding.failureSummary))}</p>` : ''}
    <dl><dt>Why it matters</dt><dd>${esc(guidance.whyItMatters)}</dd><dt>Suggested fix</dt><dd>${esc(
      guidance.suggestedFix
    )}</dd><dt>How to retest</dt><dd>${esc(guidance.howToRetest)}</dd></dl>
  </article>`;
}

function appendices(data: ReportData): string {
  const byPageAndRule = new Map<string, ReportFinding[]>();
  for (const finding of data.findings) {
    const key = `${finding.pageUrl}\u0000${finding.ruleId}`;
    byPageAndRule.set(key, [...(byPageAndRule.get(key) ?? []), finding]);
  }
  return [...byPageAndRule.entries()]
    .map(([key, findings]) => {
      const [pageUrl, ruleId] = key.split('\u0000');
      return `<section class="appendix-group${findings.length <= 3 ? ' compact' : ''}"><h3>${esc(ruleId!)} <span>${findings.length} occurrence${
        findings.length === 1 ? '' : 's'
      }</span></h3><p class="muted">${esc(pageUrl!)}</p><table><thead><tr class="context"><th colspan="4">${esc(
        ruleId!
      )} · ${esc(pageUrl!)}</th></tr><tr><th>ID</th><th>Status / severity</th><th>Selector</th><th>Observed failure</th></tr></thead><tbody>${findings
        .map(
          (finding) => `<tr><td><code>${esc(finding.id)}</code></td><td>${badge(
            finding.status,
            statusColor[finding.status] ?? '#46545c'
          )} ${badge(finding.severity, severityColor[finding.severity])}</td><td><code>${esc(
            short(finding.selector, 180) || 'Not stored'
          )}</code></td><td>${esc(short(finding.failureSummary || finding.message, 280))}</td></tr>`
        )
        .join('')}</tbody></table></section>`;
    })
    .join('');
}

export function renderReportHtml(data: ReportData): string {
  const coverageText = `${data.coverage.analyzedPages} analyzed / ${data.coverage.requestedPages} requested`;
  const finalText = data.scan.isFinal
    ? 'Complete means every requested page was analyzed. It does not mean whole-site coverage or accessibility conformance.'
    : `${data.scan.coverage} coverage or ${data.scan.status} status is provisional. No final assessment or comparison is issued.`;
  const priority = data.actionableGroups[0] ?? null;
  const representatives = selectRepresentativeFindings(data.findings, 2);
  const contrast = groupContrastPatterns(data.findings);
  const contrastPatterns = contrast.groups.length
    ? `<section class="section"><h2>Observed contrast patterns</h2><p>These are color pairings reported by axe in actionable findings. They are repair leads, not confirmed shared components or root causes.</p><table><thead><tr><th>Reported colors</th><th>Observed ratio</th><th>Required ratio</th><th>Occurrences</th><th>Pages</th><th>Example</th></tr></thead><tbody>${contrast.groups
        .map(
          (pattern) => `<tr><td><span class="swatch" style="background:${pattern.foreground}" aria-hidden="true"></span><code>${esc(
            pattern.foreground
          )}</code> on <span class="swatch" style="background:${pattern.background}" aria-hidden="true"></span><code>${esc(
            pattern.background
          )}</code></td><td>${pattern.observedMin === pattern.observedMax ? pattern.observedMin : `${pattern.observedMin}–${pattern.observedMax}`}:1</td><td>${pattern.requiredThreshold}:1</td><td>${pattern.occurrences}</td><td>${pattern.affectedPageCount}</td><td><code>${esc(
            pattern.exampleID
          )}</code><br>${esc(short(pattern.exampleSelector ?? null, 90) || 'Selector not stored')}</td></tr>`
        )
        .join('')}</tbody></table>${
        contrast.unparsedEligibleCount
          ? `<p class="muted">${contrast.unparsedEligibleCount} eligible contrast occurrence${contrast.unparsedEligibleCount === 1 ? '' : 's'} could not be parsed from stored evidence; no ratio was invented.</p>`
          : ''
      }</section>`
    : contrast.unparsedEligibleCount
      ? `<section class="section"><h2>Observed contrast patterns</h2><p>${contrast.unparsedEligibleCount} eligible contrast occurrence${contrast.unparsedEligibleCount === 1 ? '' : 's'} could not be parsed from stored evidence; no ratio was invented.</p></section>`
      : '';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Accessibility report | ${esc(
    data.project.name
  )}</title><style>
    :root{--ink:#19292f;--paper:#fffdf7;--teal:#087d78;--line:#c8d1cd;--soft:#eff5f2;--muted:#46545c}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:13px/1.45 Arial,sans-serif}.page{max-width:900px;margin:auto;padding:34px}.cover{background:#19292f;color:#fffdf7;margin:-34px -34px 30px;padding:38px 34px 30px}.brand{color:#83f0e4;font-size:11px;font-weight:800;letter-spacing:.13em;text-transform:uppercase}.cover h1{font-size:34px;line-height:1.08;margin:12px 0;overflow-wrap:anywhere}.cover p{color:#e5f0ed}.metadata{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:26px}.metadata div{border-top:1px solid #55706d;padding-top:7px}.metadata b,.label{color:#b9d9d4;display:block;font-size:10px;letter-spacing:.08em;text-transform:uppercase}.section{margin:28px 0}.section h2{font-size:21px;margin:0 0 13px}.notice{border-left:4px solid #8b5e00;background:#fff0c9;padding:12px 14px;font-weight:700}.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:9px}.kpi{background:var(--soft);border-top:3px solid var(--teal);padding:11px}.kpi b{display:block;font-size:25px;line-height:1.1}.kpi span{color:var(--muted);font-size:10px;letter-spacing:.05em;text-transform:uppercase}.grid{display:grid;grid-template-columns:1fr 1fr;gap:26px}.bars{display:grid;gap:8px}.bar{display:grid;grid-template-columns:90px 1fr 30px;gap:8px;align-items:center}.bar i{background:#dfe9e5;display:block;height:12px}.bar b{display:block;height:100%;min-width:2px}.bar strong{text-align:right}table{border-collapse:collapse;width:100%;font-size:11px}th,td{border-bottom:1px solid var(--line);padding:7px;text-align:left;vertical-align:top}th{background:#e8f0ed;color:#31433f;font-size:9px;letter-spacing:.06em;text-transform:uppercase}.context th{font-size:9px;letter-spacing:0;text-transform:none}.badge{border-radius:9px;color:#fff;display:inline-block;font-size:9px;font-weight:800;letter-spacing:.04em;margin:0 4px 4px 0;padding:2px 6px}.swatch{border:1px solid #68756f;border-radius:2px;display:inline-block;height:13px;margin:0 4px -2px 0;width:13px}.muted,.url{color:var(--muted);overflow-wrap:anywhere}.evidence{border:1px solid var(--line);border-left:4px solid var(--teal);break-inside:avoid;margin:10px 0;padding:12px}.evidence h3{font-size:15px;margin:8px 0}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;white-space:pre-wrap}dl{display:grid;gap:3px;margin:9px 0 0}dt{font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase}dd{margin:0}.appendix-group{break-inside:avoid;margin:18px 0}.appendix-group h3{font-size:15px;margin-bottom:3px}.appendix-group h3 span{color:var(--muted);font-size:11px;font-weight:normal}.appendix-group th:first-child,.appendix-group td:first-child{width:22%}.appendix-group td:first-child code{white-space:nowrap;font-size:8px;overflow-wrap:normal}.shots{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.shots figure{border:1px solid var(--line);margin:0;padding:8px}.shots img{display:block;max-height:320px;max-width:100%;object-fit:contain}.shots figcaption{color:var(--muted);font-size:10px;margin-top:6px;overflow-wrap:anywhere}footer{border-top:1px solid var(--line);color:var(--muted);font-size:10px;margin-top:28px;padding-top:10px}@media print{body{font-size:11px}.page{max-width:none;padding:0}.cover{margin:0 -2mm 18px;padding:26px 14mm}.section{break-inside:auto}.section>h2{break-after:avoid}.evidence{break-inside:avoid}.appendix-group{break-inside:auto}.appendix-group.compact{break-inside:avoid}thead{display:table-header-group}tr{break-inside:avoid}.kpi b{font-size:21px}}</style></head><body><main class="page">
    <header class="cover"><div class="brand">Propellic · Accessibility reporting</div><h1>${esc(data.project.name)}</h1><p>${esc(
      data.project.baseUrl
    )}</p><div class="metadata"><div><b>Scan ID</b>${esc(data.scan.id)}</div><div><b>Status / coverage</b>${esc(
      data.scan.status
    )} / ${esc(data.scan.coverage)}</div><div><b>Scan completed</b>${esc(fmt(data.scan.completedAt))}</div><div><b>Report generated</b>${esc(
      fmt(data.generatedAt)
    )}</div></div></header>
    <section class="section"><h2>Executive overview</h2><p class="notice">${esc(finalText)}</p><div class="kpis"><div class="kpi"><b>${data.coverage.requestedPages}</b><span>Requested</span></div><div class="kpi"><b>${data.coverage.analyzedPages}</b><span>Analyzed</span></div><div class="kpi"><b>${data.totals.findings}</b><span>Occurrences</span></div><div class="kpi"><b>${data.totals.uniqueRules}</b><span>Rule types</span></div><div class="kpi"><b>${data.totals.affectedPages}</b><span>Affected pages</span></div></div><p><b>${coverageText}.</b> ${data.totals.actionableFindings} actionable occurrence${
      data.totals.actionableFindings === 1 ? '' : 's'
    } exclude FIXED and WAIVED states.</p></section>
    <section class="section"><h2>Recorded distribution and action priority</h2><div class="grid"><div><h3>All recorded states by severity</h3>${bars(
      SEVERITY_ORDER.map((severity) => ({ label: severity, value: data.totals.bySeverity[severity], color: severityColor[severity] }))
    )}</div><div><h3>All recorded states by status</h3>${bars(
      STATUS_ORDER.map((status) => ({ label: status, value: data.totals.byStatus[status], color: statusColor[status] ?? '#46545c' }))
    )}</div></div>${priority ? `<p>Action priority: <b>${esc(priority.ruleId)}</b> has ${priority.actionableOccurrences} actionable occurrence(s) across ${priority.actionableAffectedPages} actionable page(s) (worst: ${esc(priority.actionableMaxSeverity ?? 'MINOR')}). Priority reflects actionable observed severity and frequency, not effort or root cause.</p>` : '<p>No actionable occurrences were recorded. This does not establish accessibility conformance; recorded FIXED or WAIVED states are not actions to start fixing.</p>'}</section>
    ${data.comparison ? `<section class="section"><h2>Comparable prior scan</h2><p>The prior scan completed ${esc(
      fmt(data.comparison.prevCompletedAt)
    )} with the same requested URL set. It recorded ${data.comparison.prevTotal} occurrence(s); this scan records ${data.totals.findings}. Current REGRESSED states: ${data.comparison.regressed}. Historical statuses are mutable and are not attributed to current fixes.</p></section>` : ''}
    <section class="section"><h2>Scope and methodology</h2><p>Requested pages were loaded in headless Chromium and evaluated with axe-core checks tagged WCAG 2.0 A/AA. Automated scanning covers a subset of accessibility conditions. Manual checks remain needed for keyboard behavior, screen-reader experience, content, workflows, and conditions automation cannot determine.</p><p>${esc(finalText)}</p><p class="muted">${esc(data.comparisonNote)}</p></section>
    <section class="section"><h2>Rule summaries</h2><table><thead><tr><th>Rule / references</th><th>All occurrences</th><th>Actionable</th><th>Pages</th><th>Worst severity</th></tr></thead><tbody>${data.findingGroups
      .map(
        (group) => `<tr><td><b>${esc(group.ruleId)}</b><br>${esc(group.wcagRefs.join(', ') || 'No machine WCAG reference')}</td><td>${group.occurrences}</td><td>${group.actionableOccurrences}</td><td>${group.affectedPages}</td><td>${badge(group.maxSeverity, severityColor[group.maxSeverity])}</td></tr>`
      )
      .join('') || '<tr><td colspan="5">No findings recorded.</td></tr>'}</tbody></table></section>
    ${contrastPatterns}
    <section class="section"><h2>Representative observed evidence</h2>${representatives.map(evidence).join('') || '<p>No actionable observed evidence is available.</p>'}<p class="muted">Guidance appears once per representative rule family. The appendix and CSV preserve every stored occurrence.</p></section>
    <section class="section"><h2>Coverage URL inventory</h2><table><thead><tr><th>URL</th><th>Outcome</th><th>HTTP</th><th>Occurrences</th><th>Details</th></tr></thead><tbody>${data.pages
      .map(
        (page) => `<tr><td>${esc(page.url)}<br><span class="url">${esc(page.title ?? '')}</span></td><td>${esc(page.outcome)}</td><td>${page.responseStatus ?? '—'}</td><td>${page.findingCount}</td><td>${esc(page.error ? publicFailureReason(page.error) : '—')}</td></tr>`
      )
      .join('')}</tbody></table></section>
    ${data.pages.some((page) => page.screenshot) ? `<section class="section"><h2>Page context</h2><p>Screenshots are cropped top-of-page context, not annotated problem evidence. Corrupt, missing, unsupported, or oversized images are omitted.</p><div class="shots">${data.pages.filter((page) => page.screenshot).map((page) => `<figure><img src="data:${page.screenshot!.mime};base64,${page.screenshot!.base64}" alt="Cropped top-of-page context: ${esc(page.title ?? page.url)}"><figcaption>Cropped top-of-page context · ${esc(page.title ?? page.url)}<br>${esc(page.url)}</figcaption></figure>`).join('')}</div></section>` : ''}
    <section class="section"><h2>Full occurrence appendix (${data.findings.length})</h2><p>This compact inventory retains full IDs, rule/status/severity, selector, and a brief observed failure. Full untruncated structured fields are available in CSV.</p>${appendices(
      data
    ) || '<p>No findings recorded.</p>'}</section><footer>Propellic accessibility report · Scan ${esc(data.scan.id)} · Generated ${esc(fmt(data.generatedAt))}</footer></main></body></html>`;
}

const issues = JSON.parse(process.argv[2] ?? '');
const required = ['.first-bad', '.second-bad'];
for (const selector of required) {
  const issue = issues.issues.find((item) => item.selector === selector);
  if (!issue) throw new Error(`missing expected issue ${selector}`);
  if (!issue.evidence?.domSnippet || !issue.evidence?.meta?.failureSummary) throw new Error(`missing inline DOM/failure evidence for ${selector}`);
  const evidence = await (await fetch(`http://127.0.0.1:3001/issues/${issue.id}/evidence`)).json();
  if (evidence.domSnippet !== issue.evidence.domSnippet || evidence.meta?.failureSummary !== issue.evidence.meta?.failureSummary) throw new Error(`evidence endpoint mismatch for ${selector}`);
  const screenshot = await fetch(`http://127.0.0.1:3001${evidence.screenshot}`);
  const bytes = new Uint8Array(await screenshot.arrayBuffer());
  if (!screenshot.ok || screenshot.headers.get('content-type') !== 'image/png' || bytes.length === 0) throw new Error(`missing PNG evidence for ${selector}`);
}
console.log('acceptance evidence endpoints verified');

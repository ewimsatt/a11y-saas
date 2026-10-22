import fs from 'node:fs/promises';
import path from 'node:path';
import { buildPptx } from '../apps/api/src/lib/report/pptx.ts';
import { renderReportHtml } from '../apps/api/src/lib/report/html.ts';
import { renderPdf } from '../apps/api/src/lib/report/pdf.ts';
import { buildFindingsCsv } from '../apps/api/src/lib/report/quality.ts';
import {
  FIXTURE_KINDS,
  buildFixtureData,
  fixtureOutputDirectory
} from './report-fixtures.ts';

async function main(): Promise<void> {
  const output = fixtureOutputDirectory();
  await fs.mkdir(output, { recursive: true });

  for (const kind of FIXTURE_KINDS) {
    const report = buildFixtureData(kind);
    const html = renderReportHtml(report);
    await Promise.all([
      fs.writeFile(path.join(output, `${kind}.html`), html),
      fs.writeFile(path.join(output, `${kind}.pdf`), await renderPdf(html, report.scan.id)),
      fs.writeFile(path.join(output, `${kind}.pptx`), await buildPptx(report)),
      fs.writeFile(path.join(output, `${kind}.csv`), buildFindingsCsv(report))
    ]);
  }

  console.log(`Wrote synthetic test fixtures to ${output}`);
}

void main();

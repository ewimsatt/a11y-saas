import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '@a11y/db';

async function main() {
  const { default: sharp } = await import('/app/node_modules/sharp/lib/index.js');
  const evidenceDir = process.env.EVIDENCE_DIR;
  if (!evidenceDir) throw new Error('EVIDENCE_DIR is required');

  const marker = { r: 255, g: 0, b: 255 };
  const screenshot = await sharp({
    create: { width: 900, height: 560, channels: 3, background: marker }
  }).png().toBuffer();

  const project = await prisma.project.create({
    data: { name: 'Alpha native PDF acceptance', baseUrl: 'https://example.com/' }
  });
  const scan = await prisma.scan.create({
    data: {
      projectId: project.id,
      status: 'completed',
      coverage: 'COMPLETE',
      startedAt: new Date(),
      completedAt: new Date()
    }
  });
  const page = await prisma.page.create({
    data: {
      scanId: scan.id,
      url: 'https://example.com/',
      title: 'Native PDF marker fixture',
      status: 200,
      outcome: 'ANALYZED'
    }
  });
  await prisma.rule.upsert({
    where: { id: 'alpha-pdf-marker' },
    create: { id: 'alpha-pdf-marker', title: 'Alpha PDF marker', wcagRefs: ['1.1.1'] },
    update: {}
  });
  const finding = await prisma.finding.create({
    data: {
      scanId: scan.id,
      pageId: page.id,
      ruleId: 'alpha-pdf-marker',
      severity: 'SERIOUS',
      fingerprint: `alpha-pdf-marker:${scan.id}`,
      selector: '#alpha-pdf-marker',
      message: 'Deterministic screenshot marker for native PDF acceptance'
    }
  });
  const relative = `pages/${page.id}.1.alpha-pdf-marker.png`;
  await mkdir(path.join(evidenceDir, 'pages'), { recursive: true });
  await writeFile(path.join(evidenceDir, relative), screenshot, { flag: 'wx' });
  await prisma.evidence.create({
    data: {
      findingId: finding.id,
      screenshot: relative,
      domSnippet: '<div id="alpha-pdf-marker">fixture</div>',
      meta: { title: page.title, url: page.url }
    }
  });

  console.log(JSON.stringify({ scanId: scan.id, pageId: page.id, findingId: finding.id, screenshot: relative, marker }));
}

main().finally(() => prisma.$disconnect());

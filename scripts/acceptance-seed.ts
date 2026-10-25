import { prisma } from '@a11y/db';

async function main() {
  const fixtureOrigin = process.env.FIXTURE_ORIGIN;
  if (!fixtureOrigin) throw new Error('FIXTURE_ORIGIN is required');
  const projects = await Promise.all([
    prisma.project.create({ data: { name: 'Acceptance clean', baseUrl: `${fixtureOrigin}/clean` } }),
    prisma.project.create({ data: { name: 'Acceptance violations', baseUrl: `${fixtureOrigin}/violations` } }),
    prisma.project.create({ data: { name: 'Acceptance partial', baseUrl: `${fixtureOrigin}/clean` } }),
    prisma.project.create({ data: { name: 'Acceptance atomic evidence', baseUrl: `${fixtureOrigin}/violations` } })
  ]);
  console.log(JSON.stringify({ cleanProjectId: projects[0].id, violationProjectId: projects[1].id, partialProjectId: projects[2].id, atomicEvidenceProjectId: projects[3].id }));
}

main().finally(() => prisma.$disconnect());

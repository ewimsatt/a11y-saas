import { prisma } from '@a11y/db';

async function main() {
  const [scanId, failureUrl] = process.argv.slice(2);
  if (!scanId || !failureUrl) throw new Error('usage: acceptance-add-failed-page.ts <scanId> <failureUrl>');
  await prisma.page.create({ data: { scanId, url: failureUrl } });
}

main().finally(() => prisma.$disconnect());

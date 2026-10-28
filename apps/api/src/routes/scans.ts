import { createHash } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { prisma } from '@a11y/db';
import { z } from 'zod';
import { checkScanTargetUrl, publicFailureReason } from '@a11y/shared';
import { errorMessage } from '../lib/errors';
import { dispatchScan } from '../lib/scanDispatch';

const runScanSchema = z.object({
  urls: z
    .array(
      z
        .string()
        .url()
        .superRefine((value, ctx) => {
          const result = checkScanTargetUrl(value);
          if (!result.ok) ctx.addIssue({ code: 'custom', message: result.reason });
        })
    )
    .max(20)
    .optional()
});

function requestKey(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const key = value.trim();
  if (key.length === 0 || key.length > 255) throw new Error('Idempotency-Key must be between 1 and 255 characters');
  return key;
}

function requestDigest(projectId: string, urls: string[]): string {
  return createHash('sha256').update(JSON.stringify({ projectId, urls })).digest('hex');
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

export async function scanRoutes(app: FastifyInstance) {
  app.post('/scans/:projectId/run', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return reply.code(404).send({ error: 'Project not found' });

    try {
      const input = runScanSchema.parse(req.body ?? {});
      const urls = input.urls?.length ? input.urls : [project.baseUrl];
      const key = requestKey(req.headers['idempotency-key']);
      const digest = requestDigest(projectId, urls);

      if (key) {
        const existing = await prisma.scan.findUnique({ where: { requestKey: key } });
        if (existing) {
          if (existing.requestDigest !== digest) return reply.code(409).send({ error: 'Idempotency-Key was already used with a different scan request' });
          return reply.code(202).send({ scanId: existing.id, projectId: existing.projectId, status: existing.status });
        }
      }

      const scan = await prisma.$transaction(async (tx) => {
        const created = await tx.scan.create({
          data: { projectId, status: 'queued', startedAt: new Date(), requestKey: key, requestDigest: key ? digest : null }
        });
        await tx.page.createMany({ data: urls.map((url) => ({ scanId: created.id, url })) });
        await tx.scanDispatch.create({ data: { scanId: created.id, jobId: `${created.id}-crawl`, state: 'PENDING' } });
        return created;
      });

      // Redis is deliberately outside the database transaction. A failure here
      // leaves the committed intent PENDING for the bounded API dispatcher.
      void dispatchScan(scan.id).catch((error) => req.log.warn({ err: error, scanId: scan.id }, 'initial scan dispatch deferred'));
      return reply.code(202).send({ scanId: scan.id, projectId, status: 'queued' });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const key = requestKey(req.headers['idempotency-key']);
        if (key) {
          const existing = await prisma.scan.findUnique({ where: { requestKey: key } });
          if (existing) {
            const input = runScanSchema.parse(req.body ?? {});
            const urls = input.urls?.length ? input.urls : [project.baseUrl];
            if (existing.requestDigest === requestDigest(projectId, urls)) {
              return reply.code(202).send({ scanId: existing.id, projectId: existing.projectId, status: existing.status });
            }
            return reply.code(409).send({ error: 'Idempotency-Key was already used with a different scan request' });
          }
        }
      }
      req.log.warn({ err: error }, 'scan creation failed');
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.get('/projects/:projectId/scans', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    const scans = await prisma.scan.findMany({
      where: { projectId }, orderBy: { startedAt: 'desc' }, take: 20,
      include: { _count: { select: { findings: true, pages: true } } }
    });
    return { projectId, scans };
  });

  app.get('/scans/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const scan = await prisma.scan.findUnique({
      where: { id }, include: { pages: { orderBy: { url: 'asc' } }, _count: { select: { findings: true, pages: true } } }
    });
    if (!scan) return reply.code(404).send({ error: 'Scan not found' });
    return { ...scan, pages: scan.pages.map((page) => ({ ...page, error: page.error ? publicFailureReason(page.error) : null })) };
  });

  app.get('/scans/:id/issues', async (req) => {
    const { id } = req.params as { id: string };
    const issues = await prisma.finding.findMany({
      where: { scanId: id, status: { not: 'WAIVED' } }, include: { rule: true, evidence: true }, orderBy: [{ severity: 'desc' }, { ruleId: 'asc' }]
    });
    return { scanId: id, issues };
  });
}

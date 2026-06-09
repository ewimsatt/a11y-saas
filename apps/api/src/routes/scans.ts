import { FastifyInstance } from 'fastify';
import { prisma } from '@a11y/db';
import { z } from 'zod';
import { QUEUES, checkScanTargetUrl } from '@a11y/shared';
import { getCrawlQueue } from '../lib/queues';
import { errorMessage } from '../lib/errors';

const runScanSchema = z.object({
  urls: z
    .array(
      z
        .string()
        .url()
        .superRefine((value, ctx) => {
          const result = checkScanTargetUrl(value);
          if (!result.ok) {
            ctx.addIssue({ code: 'custom', message: result.reason });
          }
        })
    )
    .max(20)
    .optional()
});

export async function scanRoutes(app: FastifyInstance) {
  app.post('/scans/:projectId/run', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }
    try {
      const input = runScanSchema.parse(req.body ?? {});
      const urls = input.urls?.length ? input.urls : [project.baseUrl];
      const scan = await prisma.scan.create({
        data: { projectId, status: 'queued', startedAt: new Date() }
      });
      await prisma.page.createMany({
        data: urls.map((url) => ({ scanId: scan.id, url }))
      });
      await getCrawlQueue().add(
        QUEUES.crawl,
        { scanId: scan.id },
        { jobId: scan.id, removeOnComplete: true, removeOnFail: true }
      );
      return reply.code(202).send({ scanId: scan.id, projectId, status: 'queued' });
    } catch (e) {
      req.log.warn({ err: e }, 'scan enqueue failed');
      return reply.code(400).send({ error: errorMessage(e) });
    }
  });

  app.get('/projects/:projectId/scans', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }
    const scans = await prisma.scan.findMany({
      where: { projectId },
      orderBy: { startedAt: 'desc' },
      take: 20,
      include: { _count: { select: { findings: true, pages: true } } }
    });
    return { projectId, scans };
  });

  app.get('/scans/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const scan = await prisma.scan.findUnique({
      where: { id },
      include: { _count: { select: { findings: true, pages: true } } }
    });
    if (!scan) {
      return reply.code(404).send({ error: 'Scan not found' });
    }
    return scan;
  });

  app.get('/scans/:id/issues', async (req) => {
    const { id } = req.params as { id: string };
    const issues = await prisma.finding.findMany({
      where: { scanId: id, status: { not: 'WAIVED' } },
      include: {
        rule: true,
        evidence: true
      },
      orderBy: [{ severity: 'desc' }, { ruleId: 'asc' }]
    });
    return { scanId: id, issues };
  });
}

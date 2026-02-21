import { FastifyInstance } from 'fastify';
import { prisma } from '@a11y/db';
import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { QUEUES } from '../../../../apps/worker/src/queues.js';
import { z } from 'zod';

const runScanSchema = z.object({
  urls: z.array(z.string().url()).max(20).optional()
});

export async function scanRoutes(app: FastifyInstance) {
  app.post('/scans/:projectId/run', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }
    try {
      const input = runScanSchema.parse(req.body);
      const urls = input.urls?.length ? input.urls : [project.baseUrl];
      const scan = await prisma.scan.create({
        data: { projectId, status: 'queued' }
      });
      for (const url of urls) {
        await prisma.page.create({
          data: { scanId: scan.id, url }
        });
      }
      const connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
      const crawlQueue = new Queue(QUEUES.crawl, { connection });
      await crawlQueue.add(QUEUES.crawl, { scanId: scan.id }, {
        jobId: scan.id,
        removeOnComplete: true,
        removeOnFail: true
      });
      return reply.code(202).send({ scanId: scan.id, projectId, status: 'queued' });
    } catch (e: any) {
      return reply.code(400).send({ error: e.errors?.[0]?.message || e.message });
    }
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

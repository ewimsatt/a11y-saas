import { FastifyInstance } from 'fastify';
import { prisma } from '@a11y/db';
import { z } from 'zod';

const waiveSchema = z.object({
  reason: z.string().min(10, 'Reason must be at least 10 characters'),
  expiresAt: z.string().datetime().optional()
});

export async function issueRoutes(app: FastifyInstance) {
  app.get('/:id/evidence', async (req, reply) => {
    const { id } = req.params as { id: string };
    const finding = await prisma.finding.findUnique({
      where: { id },
      include: { evidence: true, page: true }
    });
    if (!finding?.evidence) {
      return reply.code(404).send({ error: 'Evidence not found' });
    }
    return {
      issueId: id,
      screenshot: `/evidence/${finding.evidence.screenshot}`,
      domSnippet: finding.evidence.domSnippet,
      meta: {
        title: finding.page?.title,
        url: finding.page?.url
      }
    };
  });

  app.post('/:id/waive', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const input = waiveSchema.parse(req.body);
      await prisma.finding.update({
        where: { id },
        data: {
          status: 'WAIVED',
          waivedReason: input.reason,
          waivedAt: new Date(),
          ...(input.expiresAt && { waivedExpiresAt: new Date(input.expiresAt) })
        }
      });
      return { issueId: id, waived: true };
    } catch (e: any) {
      return reply.code(400).send({ error: e.errors?.[0]?.message || e.message || 'Update failed' });
    }
  });

  app.get('/issues/:id/evidence', async (req, reply) => {
    const { id } = req.params as { id: string };
    const finding = await prisma.finding.findUnique({
      where: { id },
      include: { evidence: true, page: true }
    });
    if (!finding?.evidence) {
      return reply.code(404).send({ error: 'Evidence not found' });
    }
    return {
      issueId: id,
      screenshot: `/evidence/${finding.evidence.screenshot}`,
      domSnippet: finding.evidence.domSnippet,
      meta: {
        title: finding.page?.title,
        url: finding.page?.url
      }
    };
  });

  app.post('/issues/:id/waive', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const input = waiveSchema.parse(req.body);
      await prisma.finding.update({
        where: { id },
        data: {
          status: 'WAIVED',
          waivedReason: input.reason,
          waivedAt: new Date(),
          ...(input.expiresAt && { waivedExpiresAt: new Date(input.expiresAt) })
        }
      });
      return { issueId: id, waived: true };
    } catch (e: any) {
      return reply.code(400).send({ error: e.errors?.[0]?.message || e.message || 'Update failed' });
    }
  });
}
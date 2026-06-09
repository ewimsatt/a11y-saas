import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '@a11y/db';
import { z } from 'zod';
import { errorMessage } from '../lib/errors';

const waiveSchema = z.object({
  reason: z.string().min(10, 'Reason must be at least 10 characters'),
  expiresAt: z.string().datetime().optional()
});

async function getEvidence(req: FastifyRequest, reply: FastifyReply) {
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
}

async function waiveIssue(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  try {
    const input = waiveSchema.parse(req.body);
    const finding = await prisma.finding.findUnique({ where: { id } });
    if (!finding) {
      return reply.code(404).send({ error: 'Issue not found' });
    }
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
  } catch (e) {
    req.log.warn({ err: e }, 'waive failed');
    return reply.code(400).send({ error: errorMessage(e) });
  }
}

export async function issueRoutes(app: FastifyInstance) {
  app.get('/issues/:id/evidence', getEvidence);
  app.post('/issues/:id/waive', waiveIssue);

  // Legacy root aliases (kept for backward compatibility)
  app.get('/:id/evidence', getEvidence);
  app.post('/:id/waive', waiveIssue);
}

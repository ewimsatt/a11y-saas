import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '@a11y/db';
import { z } from 'zod';
import { errorMessage } from '../lib/errors';

const waiveSchema = z.object({
  reason: z.string().min(10, 'Reason must be at least 10 characters'),
  expiresAt: z.string().datetime().optional()
});

const clearWaiver = { status: 'OPEN' as const, waivedReason: null, waivedAt: null, waivedExpiresAt: null };

async function expireWaiver(where: { id: string } | { scanId: string }) {
  await prisma.finding.updateMany({
    where: { ...where, status: 'WAIVED', waivedExpiresAt: { lte: new Date() } },
    data: clearWaiver
  });
}

async function getEvidence(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const finding = await prisma.finding.findUnique({
    where: { id },
    include: { evidence: true, page: true }
  });
  if (!finding?.evidence) {
    return reply.code(404).send({ error: 'Evidence not found' });
  }
  const evidenceMeta = (finding.evidence.meta ?? {}) as { failureSummary?: string; help?: string; helpUrl?: string };
  return {
    issueId: id,
    screenshot: `/evidence/${finding.evidence.screenshot}`,
    domSnippet: finding.evidence.domSnippet,
    meta: {
      title: finding.page?.title,
      url: finding.page?.url,
      ...(evidenceMeta.failureSummary && { failureSummary: evidenceMeta.failureSummary }),
      ...(evidenceMeta.help && { help: evidenceMeta.help }),
      ...(evidenceMeta.helpUrl && { helpUrl: evidenceMeta.helpUrl })
    }
  };
}

async function waiveIssue(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  try {
    const input = waiveSchema.parse(req.body);
    if (input.expiresAt && new Date(input.expiresAt) <= new Date()) {
      return reply.code(400).send({ error: 'Waiver expiry must be in the future' });
    }
    await expireWaiver({ id });
    const finding = await prisma.finding.findUnique({ where: { id } });
    if (!finding) {
      return reply.code(404).send({ error: 'Issue not found' });
    }
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && expiresAt <= new Date()) {
      return reply.code(400).send({ error: 'Waiver expiry must be in the future' });
    }
    await prisma.finding.update({
      where: { id },
      data: {
        status: 'WAIVED',
        waivedReason: input.reason,
        waivedAt: new Date(),
        waivedExpiresAt: expiresAt
      }
    });
    return { issueId: id, waived: true };
  } catch (e) {
    req.log.warn({ err: e }, 'waive failed');
    return reply.code(400).send({ error: errorMessage(e) });
  }
}

async function unwaiveIssue(req: FastifyRequest, reply: FastifyReply) {
  const { id } = req.params as { id: string };
  const finding = await prisma.finding.findUnique({ where: { id } });
  if (!finding) return reply.code(404).send({ error: 'Issue not found' });
  if (finding.status === 'WAIVED') {
    await prisma.finding.updateMany({ where: { id, status: 'WAIVED' }, data: clearWaiver });
  }
  return { issueId: id, waived: false };
}

export async function issueRoutes(app: FastifyInstance) {
  app.get('/issues/:id/evidence', getEvidence);
  app.post('/issues/:id/waive', waiveIssue);
  app.post('/issues/:id/unwaive', unwaiveIssue);

  // Legacy root aliases (kept for backward compatibility)
  app.get('/:id/evidence', getEvidence);
  app.post('/:id/waive', waiveIssue);
  app.post('/:id/unwaive', unwaiveIssue);
}

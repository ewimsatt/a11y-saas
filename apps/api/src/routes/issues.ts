import { FastifyInstance } from 'fastify';
import { z } from 'zod';

const waiveSchema = z.object({
  reason: z.string().min(10, 'Reason must be at least 10 characters'),
  expiresAt: z.string().datetime().optional()
});

export async function issueRoutes(app: FastifyInstance) {
  app.get('/:id/evidence', async (req) => {
    const { id } = req.params as { id: string };
    // TODO: fetch evidence artifacts for finding ID
    return { issueId: id, evidence: null };
  });

  app.post('/:id/waive', async (req, reply) => {
    try {
      const input = waiveSchema.parse(req.body);
      // TODO: create waiver + set status WAIVED
      return reply.send({ issueId: req.params.id as string, waived: true, ...input });
    } catch (e: any) {
      return reply.code(400).send({ error: e.errors?.[0]?.message || e.message });
    }
  });
}

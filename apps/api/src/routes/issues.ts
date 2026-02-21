import { FastifyInstance } from 'fastify';

export async function issueRoutes(app: FastifyInstance) {
  app.get('/issues/:id/evidence', async (req) => {
    const { id } = req.params as { id: string };
    // TODO: fetch evidence artifacts
    return { issueId: id, evidence: null };
  });

  app.post('/issues/:id/waive', async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as { reason: string; expiresAt?: string };
    // TODO: create waiver + set status
    return { issueId: id, waived: true, ...body };
  });
}

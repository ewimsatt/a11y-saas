import { FastifyInstance } from 'fastify';

export async function scanRoutes(app: FastifyInstance) {
  app.post('/scans/:projectId/run', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    // TODO: enqueue crawl/analyze/diff/evidence jobs
    return reply.code(202).send({ scanId: 'scan_stub', projectId, status: 'queued' });
  });

  app.get('/scans/:id/issues', async (req) => {
    const { id } = req.params as { id: string };
    // TODO: fetch issues by scan id
    return { scanId: id, issues: [] };
  });
}

import { FastifyInstance } from 'fastify';

export async function projectRoutes(app: FastifyInstance) {
  app.post('/projects', async (req, reply) => {
    const body = req.body as { name: string; baseUrl: string };
    // TODO: persist via Prisma
    return reply.code(201).send({ id: 'proj_stub', ...body });
  });
}

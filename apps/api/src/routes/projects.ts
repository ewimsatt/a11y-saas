import { FastifyInstance } from 'fastify';\nimport { prisma } from '@a11y/db';

export async function projectRoutes(app: FastifyInstance) {
  app.post('/projects', async (req, reply) => {
    const body = req.body as { name: string; baseUrl: string };
    const project = await prisma.project.create({ data: body });\n    return reply.code(201).send(project);
    return reply.code(201).send({ id: 'proj_stub', ...body });
  });
}

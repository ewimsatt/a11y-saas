import { FastifyInstance } from 'fastify';
import { prisma } from '@a11y/db';
import { z } from 'zod';

const createProjectSchema = z.object({
  name: z.string().min(1, 'Name required').max(100),
  baseUrl: z.string().url('Valid URL required')
});

export async function projectRoutes(app: FastifyInstance) {
  app.get('/', async () => {
    const projects = await prisma.project.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: {
          select: { scans: true }
        }
      }
    });
    return projects;
  });

  app.post('/', async (req, reply) => {
    try {
      const input = createProjectSchema.parse(req.body);
      console.log('Creating project with input:', input);
      const project = await prisma.project.create({ data: input });
      return reply.code(201).send(project);
    } catch (e: any) {
      console.error('Full error:', e);
      return reply.code(400).send({ error: e.message, stack: e.stack });
    }
  });
}

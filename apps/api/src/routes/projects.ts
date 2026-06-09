import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '@a11y/db';
import { z } from 'zod';
import { checkScanTargetUrl } from '@a11y/shared';
import { errorMessage } from '../lib/errors';

const createProjectSchema = z.object({
  name: z.string().min(1, 'Name required').max(100),
  baseUrl: z
    .string()
    .url('Valid URL required')
    .superRefine((value, ctx) => {
      const result = checkScanTargetUrl(value);
      if (!result.ok) {
        ctx.addIssue({ code: 'custom', message: result.reason });
      }
    })
});

async function listProjects() {
  return prisma.project.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      _count: {
        select: { scans: true }
      }
    }
  });
}

async function createProject(req: FastifyRequest, reply: FastifyReply) {
  try {
    const input = createProjectSchema.parse(req.body);
    const project = await prisma.project.create({ data: input });
    return reply.code(201).send(project);
  } catch (e) {
    req.log.warn({ err: e }, 'project creation failed');
    return reply.code(400).send({ error: errorMessage(e) });
  }
}

export async function projectRoutes(app: FastifyInstance) {
  app.get('/projects', listProjects);
  app.post('/projects', createProject);

  // Legacy root aliases (kept for backward compatibility)
  app.get('/', listProjects);
  app.post('/', createProject);
}

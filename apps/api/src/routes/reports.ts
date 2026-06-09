import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildReportData } from '../lib/report/data';
import { renderReportHtml } from '../lib/report/html';
import { renderPdf } from '../lib/report/pdf';
import { buildPptx } from '../lib/report/pptx';
import { errorMessage } from '../lib/errors';

const reportQuerySchema = z.object({
  format: z.enum(['pdf', 'pptx', 'html']).default('pdf')
});

function reportFilename(projectName: string, format: string, generatedAt: Date): string {
  const slug =
    projectName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'project';
  const date = generatedAt.toISOString().slice(0, 10);
  return `a11y-report-${slug}-${date}.${format}`;
}

export async function reportRoutes(app: FastifyInstance) {
  app.get('/scans/:id/report', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = reportQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: errorMessage(parsed.error) });
    }
    const { format } = parsed.data;

    const data = await buildReportData(id);
    if (!data) {
      return reply.code(404).send({ error: 'Scan not found' });
    }

    try {
      const html = renderReportHtml(data);
      if (format === 'html') {
        return reply.type('text/html; charset=utf-8').send(html);
      }
      if (format === 'pdf') {
        const pdf = await renderPdf(html);
        return reply
          .type('application/pdf')
          .header(
            'content-disposition',
            `attachment; filename="${reportFilename(data.project.name, 'pdf', data.generatedAt)}"`
          )
          .send(pdf);
      }
      const pptx = await buildPptx(data);
      return reply
        .type('application/vnd.openxmlformats-officedocument.presentationml.presentation')
        .header(
          'content-disposition',
          `attachment; filename="${reportFilename(data.project.name, 'pptx', data.generatedAt)}"`
        )
        .send(pptx);
    } catch (e) {
      req.log.error({ err: e, scanId: id, format }, 'report generation failed');
      return reply.code(500).send({ error: 'Report generation failed' });
    }
  });
}

import type { FastifyInstance } from 'fastify';
import { catalog } from '../catalog/index.js';

export async function catalogRoutes(app: FastifyInstance) {
  app.get('/catalog', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=3600');
    return catalog;
  });
}

/**
 * n8n-transpiler — Cloudflare Worker
 *
 * POST /transpile  — accepts { workflow: <n8n JSON> }, returns { files, summary }
 * GET  /health     — standard health check
 */

import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { N8nTranspiler } from './transpiler.js';
import type { N8nWorkflow } from './types.js';

type Bindings = {
  TRANSPILER_TOKEN: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// --- Health check (unauthenticated) ---

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'n8n-transpiler',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

// --- Auth middleware for all other routes ---

app.use('/*', async (c, next) => {
  if (c.req.path === '/health') return next();

  // Trust service binding calls from MCP gateway
  if (c.req.header('X-Gateway-Tenant-Id')) return next();

  const token = c.env.TRANSPILER_TOKEN;
  if (!token) {
    return c.json({ error: 'TRANSPILER_TOKEN not configured' }, 500);
  }

  const middleware = bearerAuth({ token });
  return middleware(c, next);
});

// --- POST /transpile ---

app.post('/transpile', async (c) => {
  const startTime = Date.now();

  let body: { workflow: N8nWorkflow };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.workflow) {
    return c.json({ error: 'Missing required field: workflow' }, 400);
  }

  if (!body.workflow.name || !body.workflow.nodes || !body.workflow.connections) {
    return c.json(
      { error: 'Invalid workflow: must have name, nodes, and connections' },
      400
    );
  }

  try {
    const transpiler = new N8nTranspiler();
    const result = transpiler.transpile(body.workflow);

    return c.json({
      ...result,
      meta: {
        durationMs: Date.now() - startTime,
        inputNodes: body.workflow.nodes.length,
        outputFiles: result.files.length,
      },
    });
  } catch (error: any) {
    console.error('Transpilation failed:', error);
    return c.json(
      {
        error: 'Transpilation failed',
        message: error.message,
        stack: error.stack,
      },
      500
    );
  }
});

// --- Catch-all ---

app.all('*', (c) => {
  return c.json(
    {
      error: 'Not found',
      routes: ['GET /health', 'POST /transpile'],
    },
    404
  );
});

export default app;

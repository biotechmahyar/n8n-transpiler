<div align="center">
<img src="assets/banner.png" alt="n8n-transpiler — workflow to Workers" width="100%" />
</div>

# n8n-transpiler

Cloudflare Worker that transpiles n8n workflow JSON into deployable Worker projects. Compiler pipeline wrapped in a Hono API with bearer-token auth.

## API

### `GET /health`
Returns service status. No auth required.

### `POST /transpile`
Accepts an n8n workflow and returns scaffold-ready files.

**Auth**: Bearer token (set `TRANSPILER_TOKEN` secret).

**Request**:
```json
{
  "workflow": { "name": "...", "nodes": [...], "connections": {...} }
}
```

**Response**:
```json
{
  "files": [
    { "path": "src/index.ts", "content": "..." },
    { "path": "wrangler.toml", "content": "..." },
    { "path": "README.md", "content": "..." },
    { "path": "package.json", "content": "..." },
    { "path": "tsconfig.json", "content": "..." }
  ],
  "summary": {
    "workflowName": "My Workflow",
    "totalNodes": 5,
    "supportedNodes": 4,
    "unsupportedNodes": 1,
    "resources": { "secrets": 1, "databases": 0, "ai": false, "queues": 1, "cronTriggers": 0 }
  },
  "meta": { "durationMs": 12, "inputNodes": 5, "outputFiles": 5 }
}
```

## Setup

```bash
npm install
wrangler secret put TRANSPILER_TOKEN
wrangler dev
```

## Deploy

```bash
wrangler deploy
```

## Architecture

```
POST /transpile
  -> WorkflowParser (n8n JSON -> IR)
  -> WorkerGeneratorV2 (IR -> TypeScript + config files)
  -> files[] response
```

The compiler pipeline supports: webhook triggers, schedule triggers, HTTP requests, conditionals (IF), switch nodes, loops (splitInBatches), data transforms, database queries (Postgres/MySQL via Hyperdrive), AI nodes (Workers AI), and code nodes (stub only).

---

Built by [Stackbilt](https://stackbilt.dev) — Apache-2.0 License

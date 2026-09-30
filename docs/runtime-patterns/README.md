# Runtime Pattern References

Production-tested runtime patterns extracted from the n8nconverter automation engine.
These complement the n8n-transpiler's core transpilation by documenting how to **execute**
the workflows it produces.

## Origin

These patterns were extracted from `n8nconverter/src/` — a Cloudflare Workers-based automation
engine that ran production workflows for Highland AC (HVAC service business). The transpiler
code in that project is now canonical in n8n-transpiler; these files preserve the **runtime-only**
patterns that sit on top of it.

## Architecture Overview

```
n8n workflow JSON
       |
       v
  [n8n-transpiler]     <-- this repo (transpilation)
       |
       v
  IR (Intermediate Representation)
       |
       v
  [WorkflowExecutor]   <-- workflow-executor.ts
       |
       +---> [NodeExecutors]        <-- node-executors.ts (plugin pattern)
       +---> [FunctionRegistry]     <-- (platform function dispatch)
       +---> [SSEManager]           <-- sse-manager.ts (real-time streaming)
       +---> [D1 Database]          <-- schema.sql (execution tracking)
       |
  [Durable Objects]
       +---> [SequenceScheduler]    <-- do-scheduler.ts (multi-touch sequences)
       +---> [RequestDeduplicator]  <-- do-deduplicator.ts (idempotency)
       |
  [Middleware]
       +---> Auth (KV-based multi-tenant)
       +---> Analytics (Analytics Engine)
```

## Files

| File | LOC | Pattern |
|------|-----|---------|
| `workflow-executor.ts` | 272 | Orchestrator: topological execution, callbacks, branch handling |
| `node-executors.ts` | 450 | Plugin pattern (BaseNodeExecutor) + HTTP retry with exponential backoff |
| `do-scheduler.ts` | 428 | Durable Object alarm-based multi-touch workflow scheduling |
| `do-deduplicator.ts` | 312 | Idempotency via DO storage + TTL + request coalescing |
| `sse-manager.ts` | 277 | Server-Sent Events for real-time workflow progress streaming |
| `schema.sql` | 36 | D1 schema for execution tracking and lead management |

## Key Design Decisions

1. **Topological execution order** — The transpiler produces an execution graph; the executor
   walks it in topological order, skipping trigger nodes (already handled by the webhook/cron).

2. **Plugin executor pattern** — Each semantic node type (`http-request`, `transform`, `conditional`,
   `database`, `ai`, `internal-function`) has its own executor class extending `BaseNodeExecutor`.
   New node types are added by implementing `execute()` and registering in the executor map.

3. **Expression evaluation** — `BaseNodeExecutor.evaluateExpression()` handles n8n's `{{ }}` template
   syntax including `$json.field`, `$node['Name'].json.field`, `$now`, array `.join()`, and simple
   arithmetic. This is the runtime counterpart to the transpiler's expression parsing.

4. **Durable Object scheduling** — Multi-touch sequences (e.g., "send confirmation now, SMS in 5min,
   case study in 24h") use DO alarms. One DO instance per sequence, state persisted in DO storage.

5. **Request deduplication** — Idempotency for webhook-triggered workflows. Uses a separate DO per
   dedup key with TTL-based cache + request coalescing (concurrent duplicates wait for the first
   execution to complete rather than executing independently).

6. **SSE streaming** — Real-time execution progress via Server-Sent Events. The executor fires
   callbacks (`onNodeStart`, `onNodeComplete`, `onWorkflowComplete`, `onWorkflowError`) which the
   SSE manager translates to typed events on the stream.

## Usage

These are **reference implementations**, not importable modules. They document patterns for anyone
building an execution layer on top of n8n-transpiler's IR output. Adapt to your runtime
(Cloudflare Workers, Node.js, Deno, etc.) as needed.

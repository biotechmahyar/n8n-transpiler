/**
 * REFERENCE IMPLEMENTATION — extracted from n8nconverter/src/durable-objects/RequestDeduplicator.ts
 *
 * Durable Object that prevents duplicate workflow executions within a configurable time window.
 *
 * Key patterns:
 * - One DO instance per deduplication key (e.g., callId, leadId)
 * - TTL-based cache with manual expiration (DO storage has no auto-TTL)
 * - Request coalescing: concurrent duplicates wait for the first execution to complete
 *   rather than executing independently
 * - Three endpoints: /check (dedup gate), /store (cache result), /get (retrieve cached)
 *
 * Use cases:
 * - Voice platform sends duplicate webhook if caller hangs up and calls back
 * - Network retries from client
 * - ServiceTitan job creation (prevent duplicate jobs)
 */

import type { DurableObjectState } from '@cloudflare/workers-types';

interface CachedExecution {
  executionId: string;
  result: any;
  createdAt: number;
  expiresAt: number;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: any) => void;
}

export class RequestDeduplicator {
  private ctx: DurableObjectState;
  private pendingRequests: Map<string, PendingRequest[]> = new Map();

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  /**
   * Handle incoming requests
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Check for duplicate execution
    if (url.pathname === '/check' && request.method === 'POST') {
      return await this.handleCheck(request);
    }

    // Store execution result
    if (url.pathname === '/store' && request.method === 'POST') {
      return await this.handleStore(request);
    }

    // Get cached execution
    if (url.pathname === '/get' && request.method === 'GET') {
      return await this.handleGet(request);
    }

    // Clear cache (for testing/debugging)
    if (url.pathname === '/clear' && request.method === 'DELETE') {
      return await this.handleClear(request);
    }

    return new Response('Not found', { status: 404 });
  }

  /**
   * Check if execution already exists (deduplication check)
   *
   * POST /check
   * Body: { "dedupKey": "callId-123", "ttlSeconds": 60 }
   *
   * Returns:
   * - { isDuplicate: false } — New execution, proceed
   * - { isDuplicate: true, cachedResult: {...} } — Duplicate, return cached result
   * - { isDuplicate: true, isPending: true } — Execution in progress, wait for it
   */
  private async handleCheck(request: Request): Promise<Response> {
    try {
      const body: any = await request.json();
      const { dedupKey, ttlSeconds = 60 } = body;

      if (!dedupKey) {
        return new Response(JSON.stringify({
          success: false,
          error: 'dedupKey is required',
        }), { status: 400 });
      }

      // Check for cached execution
      const cached = await this.ctx.storage.get<CachedExecution>(`exec:${dedupKey}`);

      if (cached) {
        // Check if still valid
        if (Date.now() < cached.expiresAt) {
          console.log(JSON.stringify({
            event: 'dedup_cache_hit',
            dedupKey,
            executionId: cached.executionId,
            age: Date.now() - cached.createdAt,
          }));

          return new Response(JSON.stringify({
            success: true,
            isDuplicate: true,
            cachedResult: cached.result,
            executionId: cached.executionId,
            age: Date.now() - cached.createdAt,
          }));
        } else {
          // Expired, clean up
          await this.ctx.storage.delete(`exec:${dedupKey}`);
        }
      }

      // Check if execution is currently pending (request coalescing)
      if (this.pendingRequests.has(dedupKey)) {
        console.log(JSON.stringify({
          event: 'dedup_pending_hit',
          dedupKey,
          pendingCount: this.pendingRequests.get(dedupKey)?.length || 0,
        }));

        // Wait for pending execution to complete
        const result = await new Promise((resolve, reject) => {
          const pending = this.pendingRequests.get(dedupKey) || [];
          pending.push({ resolve, reject });
          this.pendingRequests.set(dedupKey, pending);

          // Timeout after 30 seconds
          setTimeout(() => {
            reject(new Error('Deduplication wait timeout'));
          }, 30000);
        });

        return new Response(JSON.stringify({
          success: true,
          isDuplicate: true,
          isPending: true,
          coalescedResult: result,
        }));
      }

      // New execution — initialize pending list
      this.pendingRequests.set(dedupKey, []);

      console.log(JSON.stringify({
        event: 'dedup_cache_miss',
        dedupKey,
        ttlSeconds,
      }));

      return new Response(JSON.stringify({
        success: true,
        isDuplicate: false,
        ttlSeconds,
      }));

    } catch (error: any) {
      console.error(JSON.stringify({
        event: 'dedup_check_error',
        error: error.message,
      }));

      return new Response(JSON.stringify({
        success: false,
        error: error.message,
      }), { status: 500 });
    }
  }

  /**
   * Store execution result in cache
   *
   * POST /store
   * Body: { "dedupKey": "callId-123", "executionId": "uuid", "result": {...}, "ttlSeconds": 60 }
   *
   * Also resolves any pending coalesced requests waiting on this key.
   */
  private async handleStore(request: Request): Promise<Response> {
    try {
      const body: any = await request.json();
      const { dedupKey, executionId, result, ttlSeconds = 60 } = body;

      if (!dedupKey || !executionId || !result) {
        return new Response(JSON.stringify({
          success: false,
          error: 'dedupKey, executionId, and result are required',
        }), { status: 400 });
      }

      const now = Date.now();
      const cached: CachedExecution = {
        executionId,
        result,
        createdAt: now,
        expiresAt: now + (ttlSeconds * 1000),
      };

      // Store in DO storage (no auto-expiration, we handle it manually)
      await this.ctx.storage.put(`exec:${dedupKey}`, cached);

      // Resolve pending requests (request coalescing)
      const pending = this.pendingRequests.get(dedupKey) || [];
      pending.forEach(({ resolve }) => resolve(result));
      this.pendingRequests.delete(dedupKey);

      console.log(JSON.stringify({
        event: 'dedup_stored',
        dedupKey,
        executionId,
        ttlSeconds,
        resolvedPending: pending.length,
      }));

      return new Response(JSON.stringify({
        success: true,
        message: 'Execution result cached',
        expiresAt: cached.expiresAt,
        resolvedPending: pending.length,
      }));

    } catch (error: any) {
      console.error(JSON.stringify({
        event: 'dedup_store_error',
        error: error.message,
      }));

      return new Response(JSON.stringify({
        success: false,
        error: error.message,
      }), { status: 500 });
    }
  }

  /**
   * Get cached execution
   *
   * GET /get?dedupKey=callId-123
   */
  private async handleGet(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const dedupKey = url.searchParams.get('dedupKey');

      if (!dedupKey) {
        return new Response(JSON.stringify({
          success: false,
          error: 'dedupKey query parameter is required',
        }), { status: 400 });
      }

      const cached = await this.ctx.storage.get<CachedExecution>(`exec:${dedupKey}`);

      if (!cached) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Execution not found',
        }), { status: 404 });
      }

      // Check if expired
      if (Date.now() >= cached.expiresAt) {
        await this.ctx.storage.delete(`exec:${dedupKey}`);
        return new Response(JSON.stringify({
          success: false,
          error: 'Execution expired',
        }), { status: 404 });
      }

      return new Response(JSON.stringify({
        success: true,
        cached,
        age: Date.now() - cached.createdAt,
      }));

    } catch (error: any) {
      return new Response(JSON.stringify({
        success: false,
        error: error.message,
      }), { status: 500 });
    }
  }

  /**
   * Clear all cached executions
   *
   * DELETE /clear
   */
  private async handleClear(request: Request): Promise<Response> {
    try {
      await this.ctx.storage.deleteAll();
      this.pendingRequests.clear();

      console.log(JSON.stringify({
        event: 'dedup_cleared',
        timestamp: Date.now(),
      }));

      return new Response(JSON.stringify({
        success: true,
        message: 'All cached executions cleared',
      }));

    } catch (error: any) {
      return new Response(JSON.stringify({
        success: false,
        error: error.message,
      }), { status: 500 });
    }
  }
}

/**
 * REFERENCE IMPLEMENTATION — extracted from n8nconverter/src/runtime/executors/
 *
 * Two files combined:
 *   1. BaseNodeExecutor.ts (192 LOC) — abstract plugin base class
 *   2. HTTPNodeExecutor.ts (258 LOC) — HTTP request executor with retry
 *
 * Key patterns:
 * - Plugin architecture: each node type extends BaseNodeExecutor
 * - Expression evaluation: handles n8n's {{ }} template syntax at runtime
 * - Exponential backoff retry: 1s -> 4s -> 16s for 5xx and 429 status codes
 * - KV-based credential resolution for multi-tenant auth
 */

// ============================================================
// BaseNodeExecutor — Abstract plugin base class
// ============================================================

import type { IRNode } from '../../types.js';
import type { ExecutionContext, NodeOutput, Env } from '../types.js';

export abstract class BaseNodeExecutor {
  /**
   * Execute a node and return its output
   */
  abstract execute(
    node: IRNode,
    context: ExecutionContext,
    env: Env
  ): Promise<NodeOutput>;

  /**
   * Helper: Evaluate expression against context
   *
   * Handles n8n expression syntax:
   * - {{ $json.field }}           — current item field access
   * - {{ $json.field.join(',') }} — array join method
   * - {{ $node['Name'].json.x }} — cross-node field reference
   * - {{ $now }}                  — current timestamp
   * - {{ $json.total * 0.1 }}    — simple arithmetic
   * - ={{ expr }}                 — expression-only format (n8n shorthand)
   */
  protected async evaluateExpression(
    expression: any,
    context: ExecutionContext
  ): Promise<any> {
    // If not a string, return as-is
    if (typeof expression !== 'string') {
      return expression;
    }

    // Handle expression-only format: ={{ expr }}
    if (expression.startsWith('={{') && expression.endsWith('}}')) {
      expression = '{{' + expression.substring(3);
    }

    // If doesn't contain {{ }}, return as-is
    if (!expression.includes('{{')) {
      return expression;
    }

    let result = expression;

    // Replace all {{ }} expressions
    const expressionRegex = /\{\{([^}]+)\}\}/g;
    result = result.replace(expressionRegex, (match: string, expr: string) => {
      const trimmedExpr = expr.trim();

      // Handle array.join() method calls FIRST (before simple field access)
      const joinMatch = trimmedExpr.match(/\$json\.([\w.]+)\.join\(['"](.*?)['"]\)/);
      if (joinMatch) {
        const field = joinMatch[1];
        const separator = joinMatch[2];
        if (context.items.length > 0) {
          const value = this.getNestedValue(context.items[0].json, field);
          if (Array.isArray(value)) {
            return value.join(separator);
          }
        }
        return match;
      }

      // Handle $json.field
      if (trimmedExpr.startsWith('$json.')) {
        const field = trimmedExpr.substring(6);
        if (context.items.length > 0 && context.items[0].json) {
          const value = this.getNestedValue(context.items[0].json, field);
          return value !== undefined ? String(value) : match;
        }
      }

      // Handle $json (entire json)
      if (trimmedExpr === '$json') {
        return context.items.length > 0 ? JSON.stringify(context.items[0].json) : match;
      }

      // Handle $node['NodeName'].json.field
      const nodeMatch = trimmedExpr.match(/\$node\['([^']+)'\]\.json\.(\w+)/);
      if (nodeMatch) {
        const nodeName = nodeMatch[1];
        const field = nodeMatch[2];
        const nodeOutput = Object.values(context.nodeOutputs).find(
          (output: any) => output.nodeName === nodeName
        );
        if (nodeOutput) {
          const value = this.getNestedValue(nodeOutput.json, field);
          return value !== undefined ? String(value) : match;
        }
      }

      // Handle $now
      if (trimmedExpr === '$now') {
        return String(Date.now());
      }

      // Handle simple arithmetic (e.g., $json.total * 0.1)
      if (trimmedExpr.includes('$json.')) {
        try {
          // Replace $json.field with actual values
          let evalExpr = trimmedExpr.replace(/\$json\.(\w+)/g, (_: string, field: string) => {
            if (context.items.length > 0) {
              const value = this.getNestedValue(context.items[0].json, field);
              return value !== undefined ? String(value) : '0';
            }
            return '0';
          });

          // Evaluate simple expressions
          const safeEval = new Function('return ' + evalExpr);
          return String(safeEval());
        } catch {
          return match;
        }
      }

      return match;
    });

    return result;
  }

  /**
   * Helper: Get nested value from object
   */
  private getNestedValue(obj: any, path: string): any {
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = current[part];
      } else {
        return undefined;
      }
    }
    return current;
  }

  /**
   * Helper: Evaluate object recursively (for nested expressions)
   */
  protected async evaluateObject(
    obj: any,
    context: ExecutionContext
  ): Promise<any> {
    if (typeof obj === 'string') {
      return this.evaluateExpression(obj, context);
    }

    if (Array.isArray(obj)) {
      return Promise.all(obj.map(item => this.evaluateObject(item, context)));
    }

    if (obj && typeof obj === 'object') {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = await this.evaluateObject(value, context);
      }
      return result;
    }

    return obj;
  }

  /**
   * Helper: Get node output by ID
   */
  protected getNodeOutput(nodeId: string, context: ExecutionContext): NodeOutput | undefined {
    return context.nodeOutputs[nodeId];
  }

  /**
   * Helper: Format error
   */
  protected formatError(error: any): NodeOutput {
    return {
      json: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
}


// ============================================================
// HTTPNodeExecutor — HTTP request with exponential backoff retry
// ============================================================

export class HTTPNodeExecutor extends BaseNodeExecutor {
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAYS = [1000, 4000, 16000]; // Exponential backoff: 1s, 4s, 16s

  async execute(
    node: IRNode,
    context: ExecutionContext,
    env: Env
  ): Promise<NodeOutput> {
    const startTime = Date.now();
    let lastError: Error | null = null;

    // Retry logic with exponential backoff
    for (let attempt = 0; attempt < this.MAX_RETRIES; attempt++) {
      try {
        const params = node.parameters;

        // Evaluate URL and body against context
        const url = await this.evaluateExpression(params.url, context);
        const method = params.method || params.requestMethod || 'GET';
        const headers = await this.buildHeaders(params, context, env);
        const body = await this.buildBody(params, context);

        console.log(JSON.stringify({
          event: 'http_request_attempt',
          attempt: attempt + 1,
          maxRetries: this.MAX_RETRIES,
          method,
          url,
          nodeName: node.name
        }));

        // Execute HTTP request
        const response = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
        });

        const contentType = response.headers.get('content-type') || '';
        let responseData;

        if (contentType.includes('application/json')) {
          responseData = await response.json();
        } else {
          responseData = await response.text();
        }

        // Check if we should retry based on status code
        if (this.shouldRetry(response.status) && attempt < this.MAX_RETRIES - 1) {
          const delay = this.RETRY_DELAYS[attempt];
          console.warn(JSON.stringify({
            event: 'http_request_retry',
            statusCode: response.status,
            attempt: attempt + 1,
            nextRetryDelayMs: delay,
            nodeName: node.name
          }));

          await this.sleep(delay);
          continue; // Retry
        }

        // Success (or non-retryable error)
        const executionTime = Date.now() - startTime;

        return {
          json: {
            statusCode: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            body: responseData,
          },
          executionTime,
        };

      } catch (error) {
        lastError = error as Error;

        // Retry on network errors (not client errors like 400, 401, 403, 404)
        if (attempt < this.MAX_RETRIES - 1) {
          const delay = this.RETRY_DELAYS[attempt];
          console.warn(JSON.stringify({
            event: 'http_request_network_error_retry',
            error: lastError.message,
            attempt: attempt + 1,
            nextRetryDelayMs: delay,
            nodeName: node.name
          }));

          await this.sleep(delay);
          continue; // Retry
        }
      }
    }

    // All retries exhausted
    return this.formatError(lastError || new Error('HTTP request failed after retries'));
  }

  /**
   * Determine if HTTP status code should trigger a retry
   *
   * Retries on:
   * - 429 Too Many Requests
   * - 500 Internal Server Error
   * - 502 Bad Gateway
   * - 503 Service Unavailable
   * - 504 Gateway Timeout
   */
  private shouldRetry(statusCode: number): boolean {
    return statusCode === 429 || (statusCode >= 500 && statusCode < 600);
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async buildHeaders(
    params: any,
    context: ExecutionContext,
    env: Env
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Handle credential-based authentication (KV lookup)
    if (params.credentialsName && context.tenantId) {
      try {
        // Format: credentialsName = "servicetitan" or "servicetitan:highlandac"
        const [credType, credTenantId] = params.credentialsName.includes(':')
          ? params.credentialsName.split(':')
          : [params.credentialsName, context.tenantId];

        const key = `cred:${credType}:${credTenantId}`;
        const credentialsJson = await env.CREDENTIALS?.get(key);

        if (credentialsJson) {
          const credentials = JSON.parse(credentialsJson);

          // ServiceTitan-specific auth headers
          if (credType === 'servicetitan' || credType.includes('servicetitan')) {
            if (credentials.accessToken) {
              headers['Authorization'] = `Bearer ${credentials.accessToken}`;
            }
            if (credentials.appKey) {
              headers['ST-App-Key'] = credentials.appKey;
            }
            if (credentials.tenantId && params.url) {
              params.url = params.url.replace('{{tenantId}}', credentials.tenantId);
            }
          } else {
            // Generic Bearer token auth
            if (credentials.token || credentials.accessToken) {
              headers['Authorization'] = `Bearer ${credentials.token || credentials.accessToken}`;
            }
          }
        }
      } catch (error: any) {
        console.error(JSON.stringify({
          event: 'credentials_load_failed',
          error: error.message,
        }));
      }
    }

    // Handle authentication (legacy header auth)
    if (params.authentication === 'headerAuth' && params.headerAuth) {
      const headerName = params.headerAuth.name || 'Authorization';
      const headerValue = await this.evaluateExpression(
        params.headerAuth.value,
        context
      );
      headers[headerName] = headerValue;
    }

    // Handle custom headers
    if (params.headerParameters?.parameters) {
      for (const header of params.headerParameters.parameters) {
        const name = await this.evaluateExpression(header.name, context);
        const value = await this.evaluateExpression(header.value, context);
        headers[name] = value;
      }
    }

    return headers;
  }

  private async buildBody(
    params: any,
    context: ExecutionContext
  ): Promise<any> {
    if (!params.body && !params.jsonParameters) {
      return null;
    }

    // Handle JSON body
    if (params.body) {
      return this.evaluateObject(params.body, context);
    }

    // Handle parameter-based body
    if (params.jsonParameters?.parameters) {
      const body: any = {};
      for (const param of params.jsonParameters.parameters) {
        const name = await this.evaluateExpression(param.name, context);
        const value = await this.evaluateExpression(param.value, context);
        body[name] = value;
      }
      return body;
    }

    return null;
  }
}

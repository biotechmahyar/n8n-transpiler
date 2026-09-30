/**
 * REFERENCE IMPLEMENTATION — extracted from n8nconverter/src/streaming/SSEManager.ts
 *
 * Server-Sent Events manager for real-time workflow execution streaming.
 * Allows callers to receive live progress updates instead of polling.
 *
 * Key patterns:
 * - ReadableStream-based SSE (compatible with Response constructor)
 * - Type-safe event system (node_start, node_complete, workflow_complete, workflow_error)
 * - Idle timeout with automatic cleanup (60s default)
 * - Auto-close on workflow completion/error (1s delay for client receipt)
 * - Edge-optimized (<50ms latency from 275+ Cloudflare locations)
 *
 * Usage:
 * ```typescript
 * const manager = new SSEManager();
 * const stream = manager.createStream(executionId);
 * // Return as SSE response:
 * return new Response(stream, {
 *   headers: {
 *     'Content-Type': 'text/event-stream',
 *     'Cache-Control': 'no-cache',
 *     'Connection': 'keep-alive',
 *   },
 * });
 *
 * // Send events during execution:
 * manager.sendEvent(executionId, { type: 'node_start', nodeId: 'n1', nodeName: 'HTTP', timestamp: Date.now() });
 * manager.sendEvent(executionId, { type: 'node_complete', nodeId: 'n1', nodeName: 'HTTP', output: {...}, duration: 234, timestamp: Date.now() });
 * manager.sendEvent(executionId, { type: 'workflow_complete', result: {...}, duration: 1234, timestamp: Date.now() });
 * // Stream auto-closes after workflow_complete or workflow_error
 * ```
 */

/**
 * Stream Event Types
 */
export type StreamEvent =
  | { type: 'node_start'; nodeId: string; nodeName: string; timestamp: number }
  | { type: 'node_complete'; nodeId: string; nodeName: string; output: any; duration: number; timestamp: number }
  | { type: 'workflow_complete'; result: any; duration: number; timestamp: number }
  | { type: 'workflow_error'; error: string; nodeId?: string; timestamp: number };

/**
 * SSE Stream State
 */
interface StreamState {
  controller: ReadableStreamDefaultController;
  startTime: number;
  lastEventTime: number;
  eventCount: number;
  closed: boolean;
}

/**
 * SSE Manager Class
 *
 * Singleton manager for all SSE connections
 */
export class SSEManager {
  private streams: Map<string, StreamState>;
  private readonly maxIdleTime = 60000; // 60 seconds

  constructor() {
    this.streams = new Map();
  }

  /**
   * Create a new SSE stream for an execution
   *
   * @param executionId - Unique execution identifier
   * @returns ReadableStream compatible with Response
   */
  createStream(executionId: string): ReadableStream {
    // Clean up existing stream if it exists
    if (this.streams.has(executionId)) {
      this.closeStream(executionId);
    }

    let controller: ReadableStreamDefaultController;

    const stream = new ReadableStream({
      start: (c) => {
        controller = c;

        // Store stream state
        this.streams.set(executionId, {
          controller: c,
          startTime: Date.now(),
          lastEventTime: Date.now(),
          eventCount: 0,
          closed: false,
        });

        // Send initial connection event
        this.sendRawEvent(c, 'connected', {
          executionId,
          timestamp: Date.now(),
          message: 'Stream connected. Waiting for workflow events...',
        });

        console.log(JSON.stringify({
          event: 'sse_stream_created',
          executionId,
          timestamp: Date.now(),
        }));
      },

      cancel: () => {
        // Client disconnected
        console.log(JSON.stringify({
          event: 'sse_stream_cancelled',
          executionId,
          timestamp: Date.now(),
        }));

        this.closeStream(executionId);
      },
    });

    // Set up idle timeout
    this.setupIdleTimeout(executionId);

    return stream;
  }

  /**
   * Send event to a specific stream
   *
   * @param executionId - Execution to send event to
   * @param event - Event data
   */
  sendEvent(executionId: string, event: StreamEvent): void {
    const state = this.streams.get(executionId);

    if (!state || state.closed) {
      console.warn(JSON.stringify({
        event: 'sse_send_failed',
        executionId,
        reason: 'stream_not_found_or_closed',
        eventType: event.type,
      }));
      return;
    }

    // Send event to stream
    this.sendRawEvent(state.controller, event.type, event);

    // Update state
    state.lastEventTime = Date.now();
    state.eventCount++;

    console.log(JSON.stringify({
      event: 'sse_event_sent',
      executionId,
      eventType: event.type,
      eventCount: state.eventCount,
    }));

    // Auto-close on workflow completion or error
    if (event.type === 'workflow_complete' || event.type === 'workflow_error') {
      setTimeout(() => this.closeStream(executionId), 1000); // 1 second delay for client to receive
    }
  }

  /**
   * Close a stream and clean up resources
   *
   * @param executionId - Execution ID to close
   */
  closeStream(executionId: string): void {
    const state = this.streams.get(executionId);

    if (!state) {
      return;
    }

    if (!state.closed) {
      try {
        // Send final event
        this.sendRawEvent(state.controller, 'stream_closed', {
          executionId,
          timestamp: Date.now(),
          totalEvents: state.eventCount,
          duration: Date.now() - state.startTime,
        });

        // Close controller
        state.controller.close();
        state.closed = true;

        console.log(JSON.stringify({
          event: 'sse_stream_closed',
          executionId,
          totalEvents: state.eventCount,
          duration: Date.now() - state.startTime,
        }));
      } catch (error: any) {
        console.error(JSON.stringify({
          event: 'sse_close_error',
          executionId,
          error: error.message,
        }));
      }
    }

    // Remove from active streams
    this.streams.delete(executionId);
  }

  /**
   * Get active stream count (for monitoring)
   */
  getActiveStreamCount(): number {
    return this.streams.size;
  }

  /**
   * Close all streams (for cleanup)
   */
  closeAllStreams(): void {
    for (const executionId of this.streams.keys()) {
      this.closeStream(executionId);
    }
  }

  /**
   * Send raw SSE-formatted event to stream
   *
   * @private
   */
  private sendRawEvent(
    controller: ReadableStreamDefaultController,
    eventType: string,
    data: any
  ): void {
    const encoder = new TextEncoder();

    // Format as Server-Sent Events spec
    const eventData = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    controller.enqueue(encoder.encode(eventData));
  }

  /**
   * Setup idle timeout for stream
   *
   * Automatically closes streams that haven't received events in maxIdleTime
   *
   * @private
   */
  private setupIdleTimeout(executionId: string): void {
    const checkInterval = 10000; // Check every 10 seconds

    const intervalId = setInterval(() => {
      const state = this.streams.get(executionId);

      if (!state || state.closed) {
        clearInterval(intervalId);
        return;
      }

      const idleTime = Date.now() - state.lastEventTime;

      if (idleTime > this.maxIdleTime) {
        console.warn(JSON.stringify({
          event: 'sse_idle_timeout',
          executionId,
          idleTime,
          maxIdleTime: this.maxIdleTime,
        }));

        this.sendRawEvent(state.controller, 'timeout', {
          executionId,
          message: 'Stream timed out due to inactivity',
          idleTime,
        });

        this.closeStream(executionId);
        clearInterval(intervalId);
      }
    }, checkInterval);
  }
}

/**
 * Global SSE manager instance
 */
export const sseManager = new SSEManager();

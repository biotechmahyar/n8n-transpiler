/**
 * REFERENCE IMPLEMENTATION — extracted from n8nconverter/src/durable-objects/WorkflowSequenceScheduler.ts
 *
 * Durable Object that handles delayed multi-touch workflow execution.
 * Production-tested with Highland AC's 5-step lead nurture sequence.
 *
 * Key patterns:
 * - DO alarm-based scheduling (no external cron needed)
 * - Immediate execution for delay=0 workflows, alarms for delayed ones
 * - Sequence state persisted in DO storage (survives worker restarts)
 * - Cancel support via alarm deletion
 * - D1 execution tracking for observability
 *
 * Architecture:
 * - Voice platform: One POST with full sequence, done
 * - This DO: Handles all scheduling, delays, execution
 * - Zero CPU load on caller for delayed workflows
 */

import { WorkflowParser } from '../parser/workflow-parser.js';
import { WorkflowExecutor } from '../runtime/WorkflowExecutor.js';
import type { Env } from '../runtime/types.js';
import type { DurableObjectState } from '@cloudflare/workers-types';

// Import workflow definitions at build time
import workflow01 from '../../workflows/smartbrandstrategies/01-immediate-confirmation.json';
import workflow02 from '../../workflows/smartbrandstrategies/02-5min-sms.json';
import workflow03 from '../../workflows/smartbrandstrategies/03-24hr-case-study.json';
import workflow04 from '../../workflows/smartbrandstrategies/04-3day-reminder.json';
import workflow05 from '../../workflows/smartbrandstrategies/05-7day-final.json';

interface ScheduledWorkflow {
  workflow: string;
  delayMs: number;
}

interface SequenceRequest {
  tenantId: string;
  sequence: ScheduledWorkflow[];
  triggerData: any;
}

export class WorkflowSequenceScheduler {
  private ctx: DurableObjectState;
  private env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
  /**
   * Handle incoming requests
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Schedule a new workflow sequence
    if (url.pathname === '/schedule' && request.method === 'POST') {
      return await this.handleSchedule(request);
    }

    // Get sequence status
    if (url.pathname === '/status' && request.method === 'GET') {
      return await this.handleStatus();
    }

    // Cancel sequence
    if (url.pathname === '/cancel' && request.method === 'DELETE') {
      return await this.handleCancel();
    }

    return new Response('Not found', { status: 404 });
  }

  /**
   * Schedule a new workflow sequence
   *
   * Executes immediate workflows (delay=0) synchronously, then sets a DO alarm
   * for the next delayed workflow. Each alarm fires, executes, and schedules the next.
   */
  private async handleSchedule(request: Request): Promise<Response> {
    try {
      const body: any = await request.json();
      const { tenantId, sequence, triggerData }: SequenceRequest = body;

      console.log('[WorkflowSequence] Scheduling sequence', {
        tenantId,
        workflowCount: sequence.length,
        leadId: triggerData.leadId,
      });

      // Validate sequence
      if (!sequence || sequence.length === 0) {
        return new Response(JSON.stringify({
          success: false,
          error: 'No workflows in sequence'
        }), { status: 400 });
      }

      // Store sequence data
      await this.ctx.storage.put('sequence', sequence);
      await this.ctx.storage.put('triggerData', triggerData);
      await this.ctx.storage.put('tenantId', tenantId);
      await this.ctx.storage.put('currentIndex', 0);
      await this.ctx.storage.put('startedAt', Date.now());

      // Execute immediate workflows (delay = 0)
      let currentIndex = 0;
      while (currentIndex < sequence.length && sequence[currentIndex].delayMs === 0) {
        await this.executeWorkflow(sequence[currentIndex], triggerData);
        currentIndex++;
      }

      // Update current index
      await this.ctx.storage.put('currentIndex', currentIndex);

      // Schedule alarm for next workflow
      if (currentIndex < sequence.length) {
        const nextWorkflow = sequence[currentIndex];
        const alarmTime = Date.now() + nextWorkflow.delayMs;

        await this.ctx.storage.setAlarm(alarmTime);

        console.log('[WorkflowSequence] Alarm scheduled', {
          workflow: nextWorkflow.workflow,
          delayMs: nextWorkflow.delayMs,
          alarmTime: new Date(alarmTime).toISOString(),
        });
      }

      return new Response(JSON.stringify({
        success: true,
        sequenceId: this.ctx.id.toString(),
        scheduledWorkflows: sequence.length,
        immediateExecutions: currentIndex,
        nextExecution: currentIndex < sequence.length
          ? new Date(Date.now() + sequence[currentIndex].delayMs).toISOString()
          : null
      }));

    } catch (error: any) {
      console.error('[WorkflowSequence] Schedule error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: error.message
      }), { status: 500 });
    }
  }

  /**
   * Get current sequence status
   */
  private async handleStatus(): Promise<Response> {
    const sequence = await this.ctx.storage.get<ScheduledWorkflow[]>('sequence');
    const currentIndex = await this.ctx.storage.get<number>('currentIndex');
    const startedAt = await this.ctx.storage.get<number>('startedAt');
    const tenantId = await this.ctx.storage.get<string>('tenantId');
    const cancelled = await this.ctx.storage.get<boolean>('cancelled');

    return new Response(JSON.stringify({
      success: true,
      tenantId,
      totalWorkflows: sequence?.length || 0,
      completed: currentIndex || 0,
      remaining: (sequence?.length || 0) - (currentIndex || 0),
      startedAt: startedAt ? new Date(startedAt).toISOString() : null,
      cancelled: cancelled || false,
      nextWorkflow: sequence && currentIndex !== undefined && currentIndex < sequence.length
        ? sequence[currentIndex].workflow
        : null
    }));
  }

  /**
   * Cancel remaining workflows in sequence
   *
   * Deletes the DO alarm (cancels future executions) and marks the sequence as cancelled.
   */
  private async handleCancel(): Promise<Response> {
    try {
      const sequence = await this.ctx.storage.get<ScheduledWorkflow[]>('sequence');
      const currentIndex = await this.ctx.storage.get<number>('currentIndex');
      const tenantId = await this.ctx.storage.get<string>('tenantId');

      if (!sequence) {
        return new Response(JSON.stringify({
          success: false,
          error: 'No sequence found'
        }), { status: 404 });
      }

      const cancelled = sequence.length - (currentIndex || 0);

      // Delete alarm (cancels future executions)
      await this.ctx.storage.deleteAlarm();

      // Mark as cancelled
      await this.ctx.storage.put('cancelled', true);
      await this.ctx.storage.put('cancelledAt', Date.now());

      console.log('[WorkflowSequence] Sequence cancelled', {
        tenantId,
        totalWorkflows: sequence.length,
        completed: currentIndex || 0,
        cancelled
      });

      return new Response(JSON.stringify({
        success: true,
        message: 'Sequence cancelled',
        cancelledWorkflows: cancelled,
        completedWorkflows: currentIndex || 0,
        totalWorkflows: sequence.length
      }));

    } catch (error: any) {
      console.error('[WorkflowSequence] Cancel error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: error.message
      }), { status: 500 });
    }
  }

  /**
   * Alarm handler — executes next scheduled workflow
   *
   * Called by the Durable Object runtime when a previously-set alarm fires.
   * Executes the current workflow, advances the index, and schedules the next alarm.
   */
  async alarm(): Promise<void> {
    console.log('[WorkflowSequence] Alarm fired');

    try {
      // Check if cancelled
      const cancelled = await this.ctx.storage.get<boolean>('cancelled');
      if (cancelled) {
        console.log('[WorkflowSequence] Sequence cancelled, skipping execution');
        return;
      }

      const sequence = await this.ctx.storage.get<ScheduledWorkflow[]>('sequence');
      const triggerData = await this.ctx.storage.get<any>('triggerData');
      const currentIndex = await this.ctx.storage.get<number>('currentIndex');

      if (!sequence || currentIndex === undefined || currentIndex >= sequence.length) {
        console.log('[WorkflowSequence] No more workflows to execute');
        return;
      }

      // Execute current workflow
      const current = sequence[currentIndex];
      console.log('[WorkflowSequence] Executing workflow', {
        workflow: current.workflow,
        index: currentIndex,
        total: sequence.length
      });

      await this.executeWorkflow(current, triggerData);

      // Move to next workflow
      const nextIndex = currentIndex + 1;
      await this.ctx.storage.put('currentIndex', nextIndex);

      // Schedule next alarm if more workflows remain
      if (nextIndex < sequence.length) {
        const next = sequence[nextIndex];
        const previousDelay = current.delayMs;
        const nextDelay = next.delayMs - previousDelay;

        const alarmTime = Date.now() + nextDelay;
        await this.ctx.storage.setAlarm(alarmTime);

        console.log('[WorkflowSequence] Next alarm scheduled', {
          workflow: next.workflow,
          delayMs: nextDelay,
          alarmTime: new Date(alarmTime).toISOString()
        });
      } else {
        console.log('[WorkflowSequence] Sequence complete', {
          totalExecuted: sequence.length,
          tenantId: await this.ctx.storage.get('tenantId')
        });
      }

    } catch (error: any) {
      console.error('[WorkflowSequence] Alarm error:', error);
      // Don't throw — we don't want to break the alarm chain
    }
  }

  /**
   * Execute a single workflow
   *
   * Parses the workflow JSON via the transpiler, executes via WorkflowExecutor,
   * and tracks the result in D1.
   */
  private async executeWorkflow(scheduled: ScheduledWorkflow, triggerData: any): Promise<void> {
    const startTime = Date.now();

    try {
      // Load workflow definition
      const workflowDef = await this.loadWorkflowDefinition(scheduled.workflow);

      if (!workflowDef) {
        throw new Error(`Workflow not found: ${scheduled.workflow}`);
      }

      // Parse workflow
      const parser = new WorkflowParser();
      const ir = parser.parse(workflowDef);

      // Execute workflow
      // Wrap triggerData so workflow can access it as $json.triggerData
      const executor = new WorkflowExecutor(this.env);
      const result = await executor.execute(ir, {
        triggerData: { triggerData },
        executionId: crypto.randomUUID(),
        tenantId: triggerData.tenantId
      });

      const executionTime = Date.now() - startTime;

      console.log('[WorkflowSequence] Workflow executed', {
        workflow: scheduled.workflow,
        success: result.success,
        executionTime,
      });

      // Track execution in D1
      if (this.env.DB) {
        await this.env.DB.prepare(`
          INSERT INTO workflow_executions (
            id, workflow_name, source, tenant_id, status,
            result_json, execution_time_ms, started_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          crypto.randomUUID(),
          scheduled.workflow,
          'sequence-scheduler',
          triggerData.tenantId,
          result.success ? 'completed' : 'failed',
          JSON.stringify(result),
          executionTime,
          startTime,
          Date.now()
        ).run();
      }

    } catch (error: any) {
      console.error('[WorkflowSequence] Workflow execution error:', {
        workflow: scheduled.workflow,
        error: error.message,
        stack: error.stack
      });

      // Track failure in D1
      if (this.env.DB) {
        try {
          await this.env.DB.prepare(`
            INSERT INTO workflow_executions (
              id, workflow_name, status, error_message,
              execution_time_ms, started_at, completed_at
            ) VALUES (?, ?, 'failed', ?, ?, ?, ?)
          `).bind(
            crypto.randomUUID(),
            scheduled.workflow,
            error.message,
            Date.now() - startTime,
            startTime,
            Date.now()
          ).run();
        } catch (dbError) {
          console.error('[WorkflowSequence] Failed to track error:', dbError);
        }
      }
    }
  }

  /**
   * Load workflow definition (static imports bundled at build time)
   */
  private async loadWorkflowDefinition(workflowId: string): Promise<any> {
    // Map workflow IDs to imported definitions
    const workflows: Record<string, any> = {
      '01-immediate-confirmation': workflow01,
      '02-5min-sms': workflow02,
      '03-24hr-case-study': workflow03,
      '04-3day-reminder': workflow04,
      '05-7day-final': workflow05
    };

    const workflow = workflows[workflowId];
    if (!workflow) {
      console.error('[WorkflowSequence] Unknown workflow:', workflowId);
      return null;
    }

    return workflow;
  }
}

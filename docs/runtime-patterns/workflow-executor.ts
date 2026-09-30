/**
 * REFERENCE IMPLEMENTATION — extracted from n8nconverter/src/runtime/WorkflowExecutor.ts
 *
 * Main workflow executor — orchestrates runtime execution of transpiled workflows.
 * Walks the IR's topological execution order, dispatches to type-specific node executors,
 * and fires callbacks for streaming/monitoring integration.
 *
 * Key patterns:
 * - Topological order execution (skip trigger nodes)
 * - Plugin-based executor dispatch via Map<SemanticNodeType, BaseNodeExecutor>
 * - Execution context accumulation (node outputs merge into item pipeline)
 * - Conditional branching with recursive branch execution
 * - Callback hooks for SSE streaming integration
 */

import type { IRWorkflow, IRNode, SemanticNodeType } from '../types.js';
import type {
  ExecutionContext,
  NodeOutput,
  WorkflowInput,
  WorkflowResult,
  Env,
} from './types.js';

/**
 * Execution Callbacks for Streaming/Monitoring
 */
export interface ExecutionCallbacks {
  onNodeStart?: (nodeId: string, nodeName: string) => void | Promise<void>;
  onNodeComplete?: (nodeId: string, nodeName: string, output: any, duration: number) => void | Promise<void>;
  onWorkflowComplete?: (result: any, duration: number) => void | Promise<void>;
  onWorkflowError?: (error: Error, nodeId?: string) => void | Promise<void>;
}
import { BaseNodeExecutor } from './executors/BaseNodeExecutor.js';
import { HTTPNodeExecutor } from './executors/HTTPNodeExecutor.js';
import { TransformNodeExecutor } from './executors/TransformNodeExecutor.js';
import { ConditionalNodeExecutor } from './executors/ConditionalNodeExecutor.js';
import { DatabaseNodeExecutor } from './executors/DatabaseNodeExecutor.js';
import { AINodeExecutor } from './executors/AINodeExecutor.js';
import { InternalFunctionExecutor } from './executors/InternalFunctionExecutor.js';

export class WorkflowExecutor {
  private executors: Map<SemanticNodeType, BaseNodeExecutor>;
  private env: Env;

  constructor(env: Env) {
    this.env = env;
    this.executors = new Map([
      ['http-request', new HTTPNodeExecutor()],
      ['transform', new TransformNodeExecutor()],
      ['conditional', new ConditionalNodeExecutor()],
      ['database', new DatabaseNodeExecutor()],
      ['ai', new AINodeExecutor()],
      ['internal-function', new InternalFunctionExecutor()],
    ]);
  }

  /**
   * Execute a workflow and return results
   *
   * @param workflow - Parsed workflow definition
   * @param input - Workflow input data
   * @param callbacks - Optional callbacks for streaming/monitoring
   */
  async execute(
    workflow: IRWorkflow,
    input: WorkflowInput,
    callbacks?: ExecutionCallbacks
  ): Promise<WorkflowResult> {
    const startTime = Date.now();

    try {
      // Initialize execution context
      const context: ExecutionContext = {
        items: [{ json: input.triggerData }],
        nodeOutputs: {},
        executionId: input.executionId || this.generateExecutionId(),
        workflowId: workflow.name,
        tenantId: input.tenantId,
        triggerData: input.triggerData,
        startedAt: startTime,
        currentStepStartedAt: startTime,
      };

      // Execute nodes in topological order
      const executionOrder = workflow.executionGraph.topologicalOrder;

      for (const nodeId of executionOrder) {
        const node = workflow.nodes.find((n) => n.id === nodeId);
        if (!node) continue;

        // Skip trigger nodes (already handled)
        if (node.semanticType.startsWith('trigger-')) {
          continue;
        }

        // Emit node start event
        if (callbacks?.onNodeStart) {
          await callbacks.onNodeStart(node.id, node.name);
        }

        // Execute node
        context.currentStepStartedAt = Date.now();
        const nodeStartTime = Date.now();
        const output = await this.executeNode(node, context);
        const nodeDuration = Date.now() - nodeStartTime;

        // Store output
        context.nodeOutputs[node.id] = {
          ...output,
          nodeName: node.name, // Store name for $node references
        };

        // Emit node complete event
        if (callbacks?.onNodeComplete) {
          await callbacks.onNodeComplete(node.id, node.name, output, nodeDuration);
        }

        // Update items for next node
        if (output.json && !output.error) {
          // If node returned array, use as items
          if (Array.isArray(output.json)) {
            context.items = output.json.map((item) => ({
              json: item,
            }));
          } else {
            // Merge node output with existing context to preserve accumulated state
            // This ensures fields added by Transform nodes aren't lost by subsequent nodes
            const existingJson = context.items[0]?.json || {};
            context.items = [{
              json: { ...existingJson, ...output.json }
            }];
          }
        }

        // Handle conditional branching
        if (node.semanticType === 'conditional' && output.json) {
          const branch = output.json.branch; // 'true' or 'false'
          const nextNode = this.getNextNodeForBranch(node, branch, workflow);

          if (nextNode) {
            // Execute the branch
            await this.executeBranch(nextNode, context, workflow);
          }
        }
      }

      const result = {
        success: true,
        items: context.items,
        nodeOutputs: context.nodeOutputs,
        executionTime: Date.now() - startTime,
      };

      // Emit workflow complete event
      if (callbacks?.onWorkflowComplete) {
        await callbacks.onWorkflowComplete(result, result.executionTime);
      }

      return result;
    } catch (error) {
      const errorResult = {
        success: false,
        items: [],
        nodeOutputs: {},
        executionTime: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };

      // Emit workflow error event
      if (callbacks?.onWorkflowError) {
        await callbacks.onWorkflowError(
          error instanceof Error ? error : new Error(String(error))
        );
      }

      return errorResult;
    }
  }

  /**
   * Execute a single node
   */
  private async executeNode(
    node: IRNode,
    context: ExecutionContext
  ): Promise<NodeOutput> {
    const executor = this.executors.get(node.semanticType);

    if (!executor) {
      return {
        json: {},
        error: `No executor found for node type: ${node.semanticType}`,
      };
    }

    try {
      return await executor.execute(node, context, this.env);
    } catch (error) {
      return {
        json: {},
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get the next node for a branch (true/false)
   */
  private getNextNodeForBranch(
    node: IRNode,
    branch: string,
    workflow: IRWorkflow
  ): IRNode | null {
    const connection = node.nextNodes.find((conn) => conn.port === branch);
    if (!connection) return null;

    return workflow.nodes.find((n) => n.id === connection.targetId) || null;
  }

  /**
   * Execute a branch recursively
   */
  private async executeBranch(
    startNode: IRNode,
    context: ExecutionContext,
    workflow: IRWorkflow
  ): Promise<void> {
    const visited = new Set<string>();
    let currentNode: IRNode | null = startNode;

    while (currentNode && !visited.has(currentNode.id)) {
      visited.add(currentNode.id);

      // Execute current node
      context.currentStepStartedAt = Date.now();
      const output = await this.executeNode(currentNode, context);

      // Store output
      context.nodeOutputs[currentNode.id] = {
        ...output,
        nodeName: currentNode.name,
      };

      // Update items
      if (output.json && !output.error) {
        if (Array.isArray(output.json)) {
          context.items = output.json.map((item) => ({ json: item }));
        } else {
          // Merge node output with existing context to preserve accumulated state
          const existingJson = context.items[0]?.json || {};
          context.items = [{
            json: { ...existingJson, ...output.json }
          }];
        }
      }

      // Get next node
      if (currentNode.nextNodes.length > 0) {
        const nextConnection: import('../types.js').NodeConnection = currentNode.nextNodes[0];
        const targetId: string = nextConnection.targetId;
        currentNode =
          workflow.nodes.find((n) => n.id === targetId) || null;
      } else {
        currentNode = null;
      }
    }
  }

  /**
   * Generate unique execution ID
   */
  private generateExecutionId(): string {
    return `exec_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }

  /**
   * Register a custom executor
   */
  registerExecutor(type: SemanticNodeType, executor: BaseNodeExecutor): void {
    this.executors.set(type, executor);
  }
}

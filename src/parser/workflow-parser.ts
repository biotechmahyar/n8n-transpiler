/**
 * Phase 1: Parse n8n workflow JSON and build semantic model
 */

import type {
  N8nWorkflow,
  N8nNode,
  IRWorkflow,
  IRNode,
  SemanticNodeType,
  NodeConnection,
  ExecutionGraph,
  GraphNode,
} from '../types.js';

export class WorkflowParser {
  private currentWorkflow?: N8nWorkflow;

  /**
   * Main entry point: parse n8n JSON into IR
   */
  parse(workflow: N8nWorkflow): IRWorkflow {
    this.currentWorkflow = workflow;

    const version = this.detectVersion(workflow);
    const nodes = workflow.nodes.map((node) => this.parseNode(node));
    const executionGraph = this.buildExecutionGraph(workflow);
    const resources = this.aggregateResources(nodes);

    return {
      name: workflow.name,
      version,
      nodes,
      executionGraph,
      resources,
      settings: {
        timeout: 300000,
        errorWorkflow: false,
        retryOnTransientFailure: true,
      },
    };
  }

  private detectVersion(workflow: N8nWorkflow): 'pre-1.0' | '1.0+' {
    if (workflow.settings?.executionOrder === 'v1') {
      return '1.0+';
    }

    const hasAINodes = workflow.nodes.some(
      (node) =>
        node.type.includes('langchain') ||
        (node.type === 'n8n-nodes-base.code' && node.typeVersion >= 2)
    );

    if (hasAINodes) {
      return '1.0+';
    }

    const hasModernCredentials = workflow.nodes.some((node) => {
      if (!node.credentials) return false;
      return Object.values(node.credentials).some(
        (cred) => typeof cred === 'object' && 'id' in cred
      );
    });

    return hasModernCredentials ? '1.0+' : 'pre-1.0';
  }

  private parseNode(node: N8nNode): IRNode {
    const semanticType = this.classifyNodeType(node.type);
    const connections = this.extractNodeConnections(node.id);

    return {
      id: node.id,
      name: node.name,
      semanticType,
      parameters: node.parameters,
      credentialRef: this.parseCredentials(node.credentials),
      nextNodes: connections,
      originalType: node.type,
      typeVersion: node.typeVersion,
    };
  }

  private classifyNodeType(nodeType: string): SemanticNodeType {
    const typeMap: Record<string, SemanticNodeType> = {
      'n8n-nodes-base.webhook': 'trigger-webhook',
      'n8n-nodes-base.webhookTrigger': 'trigger-webhook',
      'n8n-nodes-base.formTrigger': 'trigger-webhook',
      'n8n-nodes-base.scheduleTrigger': 'trigger-schedule',
      'n8n-nodes-base.cronTrigger': 'trigger-schedule',
      'n8n-nodes-base.httpRequest': 'http-request',
      'n8n-nodes-base.if': 'conditional',
      'n8n-nodes-base.switch': 'switch',
      'n8n-nodes-base.set': 'transform',
      'n8n-nodes-base.editFields': 'transform',
      'n8n-nodes-base.merge': 'merge',
      'n8n-nodes-base.splitInBatches': 'loop',
      'n8n-nodes-base.code': 'code',
      'n8n-nodes-base.openAi': 'ai',
      'n8n-nodes-base.openAiChat': 'ai',
      'n8n-nodes-base.postgres': 'database',
      'n8n-nodes-base.mysql': 'database',
    };

    return typeMap[nodeType] || 'unsupported';
  }

  private extractNodeConnections(nodeId: string): NodeConnection[] {
    if (!this.currentWorkflow) return [];

    const connections: NodeConnection[] = [];
    const nodeConnections = this.currentWorkflow.connections[nodeId];

    if (!nodeConnections) return [];

    for (const [port, targetGroups] of Object.entries(nodeConnections)) {
      if (!Array.isArray(targetGroups)) continue;

      targetGroups.forEach((targets, groupIndex) => {
        if (!Array.isArray(targets)) return;

        targets.forEach((target) => {
          const portIdentifier = targetGroups.length > 1 ? String(groupIndex) : port;

          connections.push({
            port: portIdentifier,
            targetId: target.node,
            targetIndex: target.index || 0,
          });
        });
      });
    }

    return connections;
  }

  private parseCredentials(
    credentials?: Record<string, any>
  ): IRNode['credentialRef'] {
    if (!credentials) return undefined;

    const firstCred = Object.entries(credentials)[0];
    if (!firstCred) return undefined;

    const [type, cred] = firstCred;

    if (typeof cred === 'object' && 'id' in cred) {
      return {
        id: cred.id,
        name: cred.name || type,
        type,
      };
    }

    if (typeof cred === 'string') {
      return {
        id: cred,
        name: cred,
        type,
      };
    }

    return undefined;
  }

  private buildExecutionGraph(workflow: N8nWorkflow): ExecutionGraph {
    const nodes = new Map<string, GraphNode>();
    const connections = workflow.connections;

    workflow.nodes.forEach((node) => {
      nodes.set(node.id, {
        id: node.id,
        dependencies: [],
        dependents: [],
        level: 0,
      });
    });

    for (const [sourceId, outputs] of Object.entries(connections)) {
      const sourceNode = nodes.get(sourceId);
      if (!sourceNode) continue;

      for (const connections of Object.values(outputs)) {
        for (const conn of connections) {
          const targetNode = nodes.get(conn.node);
          if (!targetNode) continue;

          targetNode.dependencies.push(sourceId);
          sourceNode.dependents.push(conn.node);
        }
      }
    }

    const topologicalOrder = this.topologicalSort(nodes);

    const entryNode =
      topologicalOrder.find((id) => {
        const node = workflow.nodes.find((n) => n.id === id);
        return (
          node &&
          (node.type.includes('trigger') || node.type.includes('webhook'))
        );
      }) || topologicalOrder[0];

    this.assignNodeLevels(nodes, entryNode);

    return {
      entryNode,
      nodes,
      topologicalOrder,
    };
  }

  private topologicalSort(nodes: Map<string, GraphNode>): string[] {
    const inDegree = new Map<string, number>();
    const queue: string[] = [];
    const result: string[] = [];

    nodes.forEach((node, id) => {
      inDegree.set(id, node.dependencies.length);
      if (node.dependencies.length === 0) {
        queue.push(id);
      }
    });

    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push(current);

      const currentNode = nodes.get(current)!;
      for (const dependent of currentNode.dependents) {
        const degree = inDegree.get(dependent)! - 1;
        inDegree.set(dependent, degree);

        if (degree === 0) {
          queue.push(dependent);
        }
      }
    }

    if (result.length !== nodes.size) {
      const remaining = Array.from(nodes.keys()).filter(id => !result.includes(id));
      const loopNodes = remaining.filter(id => {
        return this.isLoopNode(id);
      });

      if (loopNodes.length > 0) {
        result.push(...remaining);
        console.warn(`Detected ${loopNodes.length} loop cycles - will handle in code generation`);
      } else {
        throw new Error('Workflow contains problematic cycles (not loop-related)');
      }
    }

    return result;
  }

  private isLoopNode(nodeId: string): boolean {
    if (!this.currentWorkflow) return false;

    const node = this.currentWorkflow.nodes.find(n => n.id === nodeId);
    if (!node) return false;

    if (node.type === 'n8n-nodes-base.splitInBatches') {
      return true;
    }

    return this.hasLoopBackConnection(nodeId);
  }

  private hasLoopBackConnection(nodeId: string, visited = new Set<string>()): boolean {
    if (visited.has(nodeId)) return false;
    visited.add(nodeId);

    if (!this.currentWorkflow) return false;

    const connections = this.currentWorkflow.connections[nodeId];
    if (!connections) return false;

    for (const [_port, targetGroups] of Object.entries(connections)) {
      if (!Array.isArray(targetGroups)) continue;

      for (const targets of targetGroups) {
        if (!Array.isArray(targets)) continue;

        for (const target of targets) {
          const targetNode = this.currentWorkflow.nodes.find(n => n.id === target.node);
          if (targetNode?.type === 'n8n-nodes-base.splitInBatches') {
            return true;
          }

          if (this.hasLoopBackConnection(target.node, visited)) {
            return true;
          }
        }
      }
    }

    return false;
  }

  private assignNodeLevels(
    nodes: Map<string, GraphNode>,
    entryNodeId: string
  ): void {
    const visited = new Set<string>();
    const queue: Array<{ id: string; level: number }> = [
      { id: entryNodeId, level: 0 },
    ];

    while (queue.length > 0) {
      const { id, level } = queue.shift()!;

      if (visited.has(id)) continue;
      visited.add(id);

      const node = nodes.get(id)!;
      node.level = level;

      for (const dependent of node.dependents) {
        queue.push({ id: dependent, level: level + 1 });
      }
    }
  }

  private aggregateResources(nodes: IRNode[]) {
    const secrets: Map<string, any> = new Map();
    const databases: Map<string, any> = new Map();
    const cronTriggers: any[] = [];
    let needsAI = false;

    nodes.forEach((node) => {
      if (node.credentialRef) {
        const key = node.credentialRef.id;
        if (!secrets.has(key)) {
          secrets.set(key, {
            bindingName: this.generateSecretBindingName(node),
            credentialId: node.credentialRef.id,
            credentialType: node.credentialRef.type,
            description: `Credential for ${node.name}`,
          });
        }
      }

      if (node.semanticType === 'database') {
        const key = node.credentialRef?.id || node.id;
        if (!databases.has(key)) {
          const bindingName = node.name
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '') + '_DB';

          databases.set(key, {
            bindingName,
            type: 'hyperdrive',
            credentialId: node.credentialRef?.id || '',
            connectionDetails: {},
          });
        }
      }

      if (node.semanticType === 'ai') {
        needsAI = true;
      }

      if (node.semanticType === 'trigger-schedule') {
        const rule = node.parameters.rule as any;
        if (rule?.interval) {
          cronTriggers.push({
            cron: this.convertToCron(rule.interval),
            nodeId: node.id,
            nodeName: node.name,
          });
        }
      }
    });

    return {
      secrets: Array.from(secrets.values()),
      databases: Array.from(databases.values()),
      ai: needsAI,
      kv: false,
      queues: [
        {
          bindingName: 'ERROR_QUEUE',
          purpose: 'error-handling' as const,
        },
      ],
      cronTriggers,
    };
  }

  private generateSecretBindingName(node: IRNode): string {
    const nodeName = node.name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const credType = node.credentialRef?.type
      .replace('Api', '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '_');

    return `${nodeName}_${credType}_KEY`;
  }

  private convertToCron(interval: any): string {
    if (Array.isArray(interval)) {
      return '0 * * * *';
    }
    return '0 * * * *';
  }
}

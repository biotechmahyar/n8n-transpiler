/**
 * Type definitions for n8n workflow JSON structure and transpiler IR
 */

// n8n Workflow JSON Types
export interface N8nWorkflow {
  name: string;
  nodes: N8nNode[];
  connections: N8nConnections;
  settings?: N8nSettings;
  staticData?: Record<string, any>;
  id?: string;
  versionId?: string;
}

export interface N8nNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, any>;
  credentials?: Record<string, N8nCredential>;
  disabled?: boolean;
}

export interface N8nCredential {
  id?: string;
  name?: string;
}

export interface N8nConnections {
  [sourceNodeId: string]: {
    [outputPort: string]: Array<{
      node: string;
      type: string;
      index: number;
    }>;
  };
}

export interface N8nSettings {
  executionOrder?: 'v0' | 'v1';
  saveDataErrorExecution?: string;
  saveDataSuccessExecution?: string;
  saveManualExecutions?: boolean;
  callerPolicy?: string;
  timezone?: string;
}

// Intermediate Representation (IR) Types
export interface IRWorkflow {
  name: string;
  version: 'pre-1.0' | '1.0+';
  nodes: IRNode[];
  executionGraph: ExecutionGraph;
  resources: ResourceRequirements;
  settings: WorkflowSettings;
}

export interface IRNode {
  id: string;
  name: string;
  semanticType: SemanticNodeType;
  parameters: Record<string, any>;
  credentialRef?: CredentialReference;
  nextNodes: NodeConnection[];
  originalType: string;
  typeVersion: number;
}

export type SemanticNodeType =
  | 'trigger-webhook'
  | 'trigger-schedule'
  | 'http-request'
  | 'conditional'
  | 'switch'
  | 'transform'
  | 'merge'
  | 'loop'
  | 'ai'
  | 'database'
  | 'code'
  | 'unsupported';

export interface NodeConnection {
  port: string; // 'main', 'true', 'false', etc.
  targetId: string;
  targetIndex: number;
}

export interface CredentialReference {
  id: string;
  name: string;
  type: string;
}

export interface ExecutionGraph {
  entryNode: string;
  nodes: Map<string, GraphNode>;
  topologicalOrder: string[];
}

export interface GraphNode {
  id: string;
  dependencies: string[];
  dependents: string[];
  level: number;
}

export interface ResourceRequirements {
  secrets: SecretBinding[];
  databases: DatabaseBinding[];
  ai: boolean;
  kv: boolean;
  queues: QueueBinding[];
  cronTriggers: CronTrigger[];
}

export interface SecretBinding {
  bindingName: string;
  credentialId: string;
  credentialType: string;
  description: string;
}

export interface DatabaseBinding {
  bindingName: string;
  type: 'hyperdrive' | 'd1';
  credentialId: string;
  connectionDetails: {
    host?: string;
    port?: number;
    database?: string;
  };
}

export interface QueueBinding {
  bindingName: string;
  purpose: 'error-handling' | 'async-processing';
}

export interface CronTrigger {
  cron: string;
  nodeId: string;
  nodeName: string;
}

export interface WorkflowSettings {
  timeout: number;
  errorWorkflow: boolean;
  retryOnTransientFailure: boolean;
}

// Code Generation Types
export interface GeneratedWorker {
  indexTs: string;
  wranglerToml: string;
  readme: string;
}

export interface CodeGeneratorContext {
  workflow: IRWorkflow;
  nodeOutputs: Map<string, string>;
  indentLevel: number;
}

export interface ExpressionTransform {
  original: string;
  transformed: string;
  variables: string[];
}

// Transpiler API types
export interface TranspileRequest {
  workflow: N8nWorkflow;
}

export interface TranspileResponse {
  files: TranspiledFile[];
  summary: TranspileSummary;
}

export interface TranspiledFile {
  path: string;
  content: string;
}

export interface TranspileSummary {
  workflowName: string;
  totalNodes: number;
  supportedNodes: number;
  unsupportedNodes: number;
  resources: {
    secrets: number;
    databases: number;
    ai: boolean;
    queues: number;
    cronTriggers: number;
  };
}

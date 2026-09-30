/**
 * Phase 3: Code generators for each supported node type
 */

import type { IRNode, CodeGeneratorContext } from '../types.js';
import { ExpressionParser } from '../parser/expression-parser.js';

export interface NodeGenerator {
  generate(
    node: IRNode,
    context: CodeGeneratorContext
  ): { code: string; async: boolean };
}

abstract class BaseNodeGenerator implements NodeGenerator {
  protected expressionParser = new ExpressionParser();
  protected indent(context: CodeGeneratorContext): string {
    return '  '.repeat(context.indentLevel);
  }

  abstract generate(
    node: IRNode,
    context: CodeGeneratorContext
  ): { code: string; async: boolean };
}

export class WebhookTriggerGenerator extends BaseNodeGenerator {
  generate(node: IRNode, context: CodeGeneratorContext) {
    const indent = this.indent(context);
    const code = `
${indent}// n8n node: ${node.name} (${node.id})
${indent}// Parse incoming webhook request
${indent}const requestBody = await request.json();
${indent}let items = [{ json: requestBody }];
`.trim();

    return { code, async: true };
  }
}

export class HttpRequestGenerator extends BaseNodeGenerator {
  generate(node: IRNode, context: CodeGeneratorContext) {
    const indent = this.indent(context);
    const params = node.parameters;

    const url =
      typeof params.url === 'string' && this.expressionParser.hasExpressions(params.url)
        ? this.expressionParser.transformTemplate(params.url)
        : `'${params.url}'`;

    const method = params.method || 'GET';
    const headers = params.headerParameters?.parameters || [];
    const body = params.body || '';

    const headersCode = headers.length > 0
      ? `{
${indent}    ${headers
        .map((h: any) => {
          const name = h.name;
          const value = this.expressionParser.hasExpressions(h.value)
            ? this.expressionParser.transformTemplate(h.value)
            : `'${h.value}'`;
          return `'${name}': ${value}`;
        })
        .join(',\n' + indent + '    ')}
${indent}  }`
      : '{}';

    let authCode = '';
    if (node.credentialRef) {
      const secretName = context.workflow.resources.secrets.find(
        (s) => s.credentialId === node.credentialRef!.id
      )?.bindingName;

      if (secretName) {
        authCode = `
${indent}const authToken_${node.id} = await env.${secretName}.get();
${indent}`;
      }
    }

    const code = `
${indent}// n8n node: ${node.name} (${node.id})
${indent}// HTTP Request: ${method} ${params.url}
${authCode}${indent}const response_${node.id} = await fetch(${url}, {
${indent}  method: '${method}',
${indent}  headers: ${headersCode},
${body ? `${indent}  body: JSON.stringify(items[0].json),` : ''}
${indent}});

${indent}if (!response_${node.id}.ok) {
${indent}  throw new Error(\`HTTP request failed: \${response_${node.id}.status} \${response_${node.id}.statusText}\`);
${indent}}

${indent}const data_${node.id} = await response_${node.id}.json();
${indent}items = [{ json: data_${node.id} }];
`.trim();

    context.nodeOutputs.set(node.id, `items`);
    return { code, async: true };
  }
}

export class EditFieldsGenerator extends BaseNodeGenerator {
  generate(node: IRNode, context: CodeGeneratorContext) {
    const indent = this.indent(context);
    const params = node.parameters;

    const fields = params.fields?.values || [];

    if (fields.length === 0) {
      return { code: `${indent}// No field operations`, async: false };
    }

    const transformations = fields.map((field: any) => {
      const name = field.name;
      const value = this.expressionParser.hasExpressions(field.value)
        ? this.expressionParser.transformTemplate(field.value)
        : typeof field.value === 'string'
        ? `'${field.value}'`
        : field.value;

      return `${name}: ${value}`;
    });

    const code = `
${indent}// n8n node: ${node.name} (${node.id})
${indent}// Transform data fields
${indent}items = items.map(item => ({
${indent}  json: {
${indent}    ...item.json,
${indent}    ${transformations.join(`,\n${indent}    `)}
${indent}  }
${indent}}));
`.trim();

    return { code, async: false };
  }
}

export class IfNodeGenerator extends BaseNodeGenerator {
  generate(node: IRNode, context: CodeGeneratorContext) {
    const indent = this.indent(context);
    const params = node.parameters;

    const conditions = params.conditions?.conditions || [];

    if (conditions.length === 0) {
      return {
        code: `${indent}// IF node with no conditions`,
        async: false,
      };
    }

    const conditionExpr = this.buildCondition(conditions[0]);

    const code = `
${indent}// n8n node: ${node.name} (${node.id})
${indent}// Conditional branch
${indent}if (${conditionExpr}) {
${indent}  // TRUE branch
${indent}  // [Next nodes will be inserted here]
${indent}} else {
${indent}  // FALSE branch
${indent}  // [Next nodes will be inserted here]
${indent}}
`.trim();

    return { code, async: false };
  }

  private buildCondition(condition: any): string {
    const leftValue = this.expressionParser.hasExpressions(condition.leftValue)
      ? this.expressionParser.transformTemplate(condition.leftValue)
      : `'${condition.leftValue}'`;

    const rightValue = this.expressionParser.hasExpressions(condition.rightValue)
      ? this.expressionParser.transformTemplate(condition.rightValue)
      : `'${condition.rightValue}'`;

    const operation = condition.operation || 'equals';

    const operatorMap: Record<string, string> = {
      equals: '===',
      notEquals: '!==',
      contains: '.includes',
      doesNotContain: '!includes',
      startsWith: '.startsWith',
      endsWith: '.endsWith',
      greater: '>',
      less: '<',
      greaterOrEquals: '>=',
      lessOrEquals: '<=',
    };

    const operator = operatorMap[operation] || '===';

    if (operator.startsWith('.')) {
      return `${leftValue}${operator}(${rightValue})`;
    }

    return `${leftValue} ${operator} ${rightValue}`;
  }
}

export class CodeNodeGenerator extends BaseNodeGenerator {
  generate(node: IRNode, context: CodeGeneratorContext) {
    const indent = this.indent(context);
    const code = `
${indent}// WARNING: n8n Code node detected (${node.id})
${indent}// Manual implementation required for security.
${indent}// Original code has been omitted.
${indent}throw new Error('Code node not supported - manual implementation required');
`.trim();

    return { code, async: false };
  }
}

export class ScheduleTriggerGenerator extends BaseNodeGenerator {
  generate(node: IRNode, context: CodeGeneratorContext) {
    const indent = this.indent(context);
    const code = `
${indent}// n8n node: ${node.name} (${node.id})
${indent}// Schedule trigger initialization
${indent}let items = [{ json: {} }];
`.trim();

    return { code, async: false };
  }
}

export class DatabaseNodeGenerator extends BaseNodeGenerator {
  generate(node: IRNode, context: CodeGeneratorContext) {
    const indent = this.indent(context);
    const params = node.parameters;

    const operation = params.operation || 'executeQuery';

    if (operation === 'executeQuery') {
      return this.generateExecuteQuery(node, context);
    } else if (operation === 'insert') {
      return this.generateInsert(node, context);
    } else if (operation === 'update') {
      return this.generateUpdate(node, context);
    } else if (operation === 'delete') {
      return this.generateDelete(node, context);
    }

    return {
      code: `${indent}// Database operation '${operation}' not yet supported`,
      async: true
    };
  }

  private generateExecuteQuery(node: IRNode, context: CodeGeneratorContext) {
    const indent = this.indent(context);
    const params = node.parameters;

    const query = params.query || '';
    const safeNodeId = node.id.replace(/-/g, '_');
    const bindingName = this.generateBindingName(node.name);

    if (this.expressionParser.hasExpressions(query)) {
      const params = this.extractQueryParameters(query);

      if (params.length > 0) {
        const parameterizedQuery = this.parameterizeQuery(query, params);
        const paramValues = params.map(p => this.expressionParser.transformTemplate(p)).join(', ');

        const code = `
${indent}// n8n node: ${node.name} (${node.id})
${indent}// Database query via Hyperdrive (parameterized)
${indent}const db_${safeNodeId} = env.${bindingName};
${indent}const result_${safeNodeId} = await db_${safeNodeId}.query(
${indent}  \`${parameterizedQuery}\`,
${indent}  [${paramValues}]
${indent});
${indent}items = result_${safeNodeId}.rows.map(row => ({ json: row }));
`.trim();

        return { code, async: true };
      }
    }

    const code = `
${indent}// n8n node: ${node.name} (${node.id})
${indent}// Database query via Hyperdrive
${indent}const db_${safeNodeId} = env.${bindingName};
${indent}const result_${safeNodeId} = await db_${safeNodeId}.query(\`${query}\`);
${indent}items = result_${safeNodeId}.rows.map(row => ({ json: row }));
`.trim();

    return { code, async: true };
  }

  private generateInsert(node: IRNode, context: CodeGeneratorContext) {
    const indent = this.indent(context);
    const params = node.parameters;

    const table = params.table || 'table';
    const columns = params.columns?.mappings || [];
    const bindingName = this.generateBindingName(node.name);
    const safeNodeId = node.id.replace(/-/g, '_');

    const columnNames = columns.map((col: any) => col.column).join(', ');
    const placeholders = columns.map((_: any, i: number) => `$${i + 1}`).join(', ');
    const values = columns.map((col: any) => {
      const value = this.expressionParser.hasExpressions(col.value)
        ? this.expressionParser.transformTemplate(col.value)
        : `'${col.value}'`;
      return value;
    }).join(', ');

    const code = `
${indent}// n8n node: ${node.name} (${node.id})
${indent}// Database INSERT via Hyperdrive
${indent}const db_${safeNodeId} = env.${bindingName};
${indent}const result_${safeNodeId} = await db_${safeNodeId}.query(
${indent}  'INSERT INTO ${table} (${columnNames}) VALUES (${placeholders}) RETURNING *',
${indent}  [${values}]
${indent});
${indent}items = result_${safeNodeId}.rows.map(row => ({ json: row }));
`.trim();

    return { code, async: true };
  }

  private generateUpdate(node: IRNode, context: CodeGeneratorContext) {
    const indent = this.indent(context);
    const params = node.parameters;

    const table = params.table || 'table';
    const bindingName = this.generateBindingName(node.name);
    const safeNodeId = node.id.replace(/-/g, '_');

    const columns = params.columns?.mappings || [];
    const setClause = columns.map((col: any, i: number) => `${col.column} = $${i + 1}`).join(', ');
    const values = columns.map((col: any) => {
      const value = this.expressionParser.hasExpressions(col.value)
        ? this.expressionParser.transformTemplate(col.value)
        : `'${col.value}'`;
      return value;
    });

    const whereCondition = params.where || 'id = $' + (columns.length + 1);

    const code = `
${indent}// n8n node: ${node.name} (${node.id})
${indent}// Database UPDATE via Hyperdrive
${indent}const db_${safeNodeId} = env.${bindingName};
${indent}const result_${safeNodeId} = await db_${safeNodeId}.query(
${indent}  'UPDATE ${table} SET ${setClause} WHERE ${whereCondition} RETURNING *',
${indent}  [${values.join(', ')}]
${indent});
${indent}items = result_${safeNodeId}.rows.map(row => ({ json: row }));
`.trim();

    return { code, async: true };
  }

  private generateDelete(node: IRNode, context: CodeGeneratorContext) {
    const indent = this.indent(context);
    const params = node.parameters;

    const table = params.table || 'table';
    const bindingName = this.generateBindingName(node.name);
    const safeNodeId = node.id.replace(/-/g, '_');
    const whereCondition = params.where || 'id = $1';

    const code = `
${indent}// n8n node: ${node.name} (${node.id})
${indent}// Database DELETE via Hyperdrive
${indent}const db_${safeNodeId} = env.${bindingName};
${indent}const result_${safeNodeId} = await db_${safeNodeId}.query(
${indent}  'DELETE FROM ${table} WHERE ${whereCondition} RETURNING *',
${indent}  [/* Add parameters based on WHERE clause */]
${indent});
${indent}items = [{ json: { deletedCount: result_${safeNodeId}.rowCount } }];
`.trim();

    return { code, async: true };
  }

  private extractQueryParameters(query: string): string[] {
    const expressions = this.expressionParser['extractExpressions'](query);
    return expressions.map(e => e.full);
  }

  private parameterizeQuery(query: string, params: string[]): string {
    let parameterizedQuery = query;
    params.forEach((param, index) => {
      parameterizedQuery = parameterizedQuery.replace(param, `$${index + 1}`);
    });
    return parameterizedQuery;
  }

  private generateBindingName(nodeName: string): string {
    return nodeName
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '') + '_DB';
  }
}

export class SwitchNodeGenerator extends BaseNodeGenerator {
  generate(node: IRNode, context: CodeGeneratorContext) {
    const indent = this.indent(context);
    const params = node.parameters;

    const rules = params.rules?.values || [];
    const fallbackOutput = params.fallbackOutput || rules.length;

    if (rules.length === 0) {
      return {
        code: `${indent}// Switch node with no rules`,
        async: false,
      };
    }

    let code = `\n${indent}// n8n node: ${node.name} (${node.id})\n`;
    code += `${indent}// Multi-branch switch\n`;

    rules.forEach((rule: any, index: number) => {
      const condition = this.buildCondition(rule);
      const elseIfKeyword = index === 0 ? 'if' : 'else if';

      code += `${indent}${elseIfKeyword} (${condition}) {\n`;
      code += `${indent}  // Route ${index}: ${this.getRouteDescription(rule)}\n`;

      const branchNodes = this.getBranchNodes(node, index);
      if (branchNodes.length > 0) {
        code += `${indent}  // [Branch ${index} nodes will be inserted here]\n`;
      }

      code += `${indent}}`;
      if (index < rules.length - 1) {
        code += ' ';
      }
    });

    code += ` else {\n`;
    code += `${indent}  // Default/Fallback route\n`;

    const fallbackNodes = this.getBranchNodes(node, fallbackOutput);
    if (fallbackNodes.length > 0) {
      code += `${indent}  // [Fallback nodes will be inserted here]\n`;
    }

    code += `${indent}}`;

    return { code, async: false };
  }

  private buildCondition(rule: any): string {
    const leftValue = this.expressionParser.hasExpressions(rule.value1)
      ? this.expressionParser.transformTemplate(rule.value1)
      : `'${rule.value1}'`;

    const rightValue = this.expressionParser.hasExpressions(rule.value2)
      ? this.expressionParser.transformTemplate(rule.value2)
      : `'${rule.value2}'`;

    const operation = rule.operation || 'equals';

    const operatorMap: Record<string, string> = {
      equals: '===',
      notEquals: '!==',
      contains: '.includes',
      doesNotContain: '!includes',
      startsWith: '.startsWith',
      endsWith: '.endsWith',
      greater: '>',
      less: '<',
      greaterOrEquals: '>=',
      lessOrEquals: '<=',
    };

    const operator = operatorMap[operation] || '===';

    if (operator.startsWith('.')) {
      return `${leftValue}${operator}(${rightValue})`;
    }

    return `${leftValue} ${operator} ${rightValue}`;
  }

  private getRouteDescription(rule: any): string {
    const value = rule.value2 || 'condition';
    return `When ${value}`;
  }

  private getBranchNodes(node: IRNode, outputIndex: number): string[] {
    const connections = node.nextNodes.filter(conn => {
      return conn.port === String(outputIndex) || conn.targetIndex === outputIndex;
    });

    return connections.map(conn => conn.targetId);
  }
}

export class LoopNodeGenerator extends BaseNodeGenerator {
  generate(node: IRNode, context: CodeGeneratorContext) {
    const indent = this.indent(context);
    const params = node.parameters;

    const batchSize = params.batchSize || 1;

    const code = `
${indent}// n8n node: ${node.name} (${node.id})
${indent}// Loop: Split in Batches (batch size: ${batchSize}) - Single iteration processing
${indent}
${indent}// Process items in batches
${indent}const originalItems = [...items];
${indent}const batchSize = ${batchSize};
${indent}
${indent}// For this iteration, take first batch
${indent}items = originalItems.slice(0, batchSize);
${indent}
${indent}// Set loop context variables for n8n expressions
${indent}context.nodeOutputs['${node.name}'] = {
${indent}  context: {
${indent}    noItemsLeft: originalItems.length <= batchSize,
${indent}    currentRunIndex: 0
${indent}  }
${indent}};
${indent}
${indent}console.log(\`Processing batch of \${items.length} items (batch size: ${batchSize})\`);
`.trim();

    return { code, async: false };
  }
}

export class AINodeGenerator extends BaseNodeGenerator {
  generate(node: IRNode, context: CodeGeneratorContext) {
    const indent = this.indent(context);
    const params = node.parameters;
    const safeNodeId = node.id.replace(/-/g, '_');

    const prompt = params.prompt || params.text || '';
    const model = this.mapModelToWorkersAI(params.model);
    const temperature = params.temperature || 0.7;
    const maxTokens = params.maxTokens || 1000;

    const promptCode = this.expressionParser.hasExpressions(prompt)
      ? this.expressionParser.transformTemplate(prompt)
      : `\`${prompt}\``;

    const code = `
${indent}// n8n node: ${node.name} (${node.id})
${indent}// AI completion via Workers AI
${indent}const aiResponse_${safeNodeId} = await env.AI.run('${model}', {
${indent}  prompt: ${promptCode},
${indent}  max_tokens: ${maxTokens},
${indent}  temperature: ${temperature}
${indent});
${indent}items = [{ json: aiResponse_${safeNodeId} }];
`.trim();

    return { code, async: true };
  }

  private mapModelToWorkersAI(n8nModel?: string): string {
    const modelMap: Record<string, string> = {
      'gpt-4': '@cf/meta/llama-3.1-70b-instruct',
      'gpt-4-turbo': '@cf/meta/llama-3.1-70b-instruct',
      'gpt-3.5-turbo': '@cf/meta/llama-3.1-8b-instruct',
      'text-davinci-003': '@cf/meta/llama-3.1-8b-instruct',
    };

    return modelMap[n8nModel || ''] || '@cf/meta/llama-3.1-8b-instruct';
  }
}

export class NodeGeneratorFactory {
  private generators = new Map<string, NodeGenerator>([
    ['trigger-webhook', new WebhookTriggerGenerator()],
    ['trigger-schedule', new ScheduleTriggerGenerator()],
    ['http-request', new HttpRequestGenerator()],
    ['transform', new EditFieldsGenerator()],
    ['conditional', new IfNodeGenerator()],
    ['switch', new SwitchNodeGenerator()],
    ['loop', new LoopNodeGenerator()],
    ['database', new DatabaseNodeGenerator()],
    ['ai', new AINodeGenerator()],
    ['code', new CodeNodeGenerator()],
  ]);

  getGenerator(nodeType: string): NodeGenerator | undefined {
    return this.generators.get(nodeType);
  }

  hasGenerator(nodeType: string): boolean {
    return this.generators.has(nodeType);
  }
}

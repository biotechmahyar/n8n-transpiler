/**
 * Branch-aware code generation (Phase 2 improvement)
 * Properly nests conditional branches instead of sequential execution
 */

import type { IRWorkflow, IRNode, CodeGeneratorContext } from '../types.js';
import { NodeGeneratorFactory } from './node-generators.js';
import { ExpressionParser } from '../parser/expression-parser.js';

export class BranchAwareGenerator {
  private factory = new NodeGeneratorFactory();
  private expressionParser = new ExpressionParser();

  generate(workflow: IRWorkflow, context: CodeGeneratorContext): string {
    const code: string[] = [];
    const processed = new Set<string>();

    this.generateNodeCode(
      workflow.executionGraph.entryNode,
      workflow,
      context,
      code,
      processed,
      context.indentLevel
    );

    return code.join('\n');
  }

  private generateNodeCode(
    nodeId: string,
    workflow: IRWorkflow,
    context: CodeGeneratorContext,
    code: string[],
    processed: Set<string>,
    indentLevel: number
  ): void {
    if (processed.has(nodeId)) return;
    processed.add(nodeId);

    const node = workflow.nodes.find((n) => n.id === nodeId);
    if (!node) {
      console.warn(`Node not found: ${nodeId}`);
      return;
    }

    const indent = '  '.repeat(indentLevel);

    if (node.semanticType === 'conditional' && node.nextNodes.length > 0) {
      this.generateConditionalBranch(
        node, workflow, context, code, processed, indentLevel
      );
    } else if (node.semanticType === 'switch' && node.nextNodes.length > 0) {
      this.generateSwitchBranch(
        node, workflow, context, code, processed, indentLevel
      );
    } else if (node.semanticType === 'loop' && node.nextNodes.length > 0) {
      this.generateLoopBranch(
        node, workflow, context, code, processed, indentLevel
      );
    } else {
      const generator = this.factory.getGenerator(node.semanticType);

      if (generator) {
        const { code: nodeCode } = generator.generate(node, {
          ...context,
          indentLevel,
        });
        code.push(nodeCode);
        code.push('');

        node.nextNodes.forEach((conn) => {
          this.generateNodeCode(
            conn.targetId, workflow, context, code, processed, indentLevel
          );
        });
      } else {
        code.push(`${indent}// Unsupported: ${node.originalType} (${node.name})`);
        code.push('');
      }
    }
  }

  private generateConditionalBranch(
    node: IRNode,
    workflow: IRWorkflow,
    context: CodeGeneratorContext,
    code: string[],
    processed: Set<string>,
    indentLevel: number
  ): void {
    const indent = '  '.repeat(indentLevel);

    const params = node.parameters;
    const conditions = params.conditions?.conditions || [];

    if (conditions.length === 0) {
      code.push(`${indent}// IF node with no conditions - skipped`);
      return;
    }

    const condition = conditions[0];
    const condExpr = this.buildConditionExpression(condition);

    code.push(`${indent}// n8n node: ${node.name} (${node.id})`);
    code.push(`${indent}if (${condExpr}) {`);

    const trueChildren = node.nextNodes.filter((n) => n.port === 'true');
    if (trueChildren.length > 0) {
      trueChildren.forEach((conn) => {
        this.generateNodeCode(
          conn.targetId, workflow, context, code, processed, indentLevel + 1
        );
      });
    } else {
      code.push(`${indent}  // No true branch`);
    }

    code.push(`${indent}} else {`);

    const falseChildren = node.nextNodes.filter((n) => n.port === 'false');
    if (falseChildren.length > 0) {
      falseChildren.forEach((conn) => {
        this.generateNodeCode(
          conn.targetId, workflow, context, code, processed, indentLevel + 1
        );
      });
    } else {
      code.push(`${indent}  // No false branch`);
    }

    code.push(`${indent}}`);
    code.push('');
  }

  private generateSwitchBranch(
    node: IRNode,
    workflow: IRWorkflow,
    context: CodeGeneratorContext,
    code: string[],
    processed: Set<string>,
    indentLevel: number
  ): void {
    const indent = '  '.repeat(indentLevel);
    const params = node.parameters;
    const rules = params.rules?.values || [];
    const fallbackOutput = params.fallbackOutput || rules.length;

    code.push(`${indent}// n8n node: ${node.name} (${node.id})`);
    code.push(`${indent}// Multi-branch switch`);

    const connectionsByOutput = new Map<number, string[]>();
    node.nextNodes.forEach((conn) => {
      const outputIndex = parseInt(conn.port) || 0;
      if (!connectionsByOutput.has(outputIndex)) {
        connectionsByOutput.set(outputIndex, []);
      }
      connectionsByOutput.get(outputIndex)!.push(conn.targetId);
    });

    rules.forEach((rule: any, index: number) => {
      const condition = this.buildConditionExpression(rule);
      const elseIfKeyword = index === 0 ? 'if' : 'else if';

      code.push(`${indent}${elseIfKeyword} (${condition}) {`);
      code.push(`${indent}  // Route ${index}: ${rule.value2 || 'condition'}`);

      const routeChildren = connectionsByOutput.get(index) || [];
      if (routeChildren.length > 0) {
        routeChildren.forEach((childId) => {
          this.generateNodeCode(
            childId, workflow, context, code, processed, indentLevel + 1
          );
        });
      } else {
        code.push(`${indent}  // No nodes in this route`);
      }

      code.push(`${indent}}${index < rules.length - 1 ? ' ' : ''}`);
    });

    code.push(` else {`);
    code.push(`${indent}  // Default/Fallback route`);

    const fallbackChildren = connectionsByOutput.get(fallbackOutput) || [];
    if (fallbackChildren.length > 0) {
      fallbackChildren.forEach((childId) => {
        this.generateNodeCode(
          childId, workflow, context, code, processed, indentLevel + 1
        );
      });
    } else {
      code.push(`${indent}  // No fallback nodes`);
    }

    code.push(`${indent}}`);
    code.push('');
  }

  private generateLoopBranch(
    node: IRNode,
    workflow: IRWorkflow,
    context: CodeGeneratorContext,
    code: string[],
    processed: Set<string>,
    indentLevel: number
  ): void {
    const generator = this.factory.getGenerator(node.semanticType);
    if (generator) {
      const { code: loopInitCode } = generator.generate(node, {
        ...context,
        indentLevel,
      });
      code.push(loopInitCode);
    }

    code.push('');

    node.nextNodes.forEach((conn) => {
      this.generateLoopBodyLinear(
        conn.targetId, node.id, workflow, context, code, processed, indentLevel
      );
    });
  }

  private generateLoopBodyLinear(
    nodeId: string,
    loopNodeId: string,
    workflow: IRWorkflow,
    context: CodeGeneratorContext,
    code: string[],
    processed: Set<string>,
    indentLevel: number,
    visited = new Set<string>()
  ): void {
    if (visited.has(nodeId) || processed.has(nodeId)) return;
    visited.add(nodeId);

    const node = workflow.nodes.find(n => n.id === nodeId);
    if (!node) return;

    const hasDirectLoopBack = node.nextNodes.some(conn => conn.targetId === loopNodeId);

    this.generateNodeCode(
      nodeId, workflow, context, code, processed, indentLevel
    );

    if (hasDirectLoopBack) {
      const indent = '  '.repeat(indentLevel);
      code.push(`${indent}// Loop completes here - would loop back to splitInBatches`);
      return;
    }

    node.nextNodes.forEach((conn) => {
      this.generateLoopBodyLinear(
        conn.targetId, loopNodeId, workflow, context, code, processed, indentLevel, visited
      );
    });
  }

  private buildConditionExpression(condition: any): string {
    const leftValue = this.transformValue(condition.leftValue || condition.value1);
    const rightValue = this.transformValue(condition.rightValue || condition.value2);
    const operation = condition.operation || 'equals';

    const operatorMap: Record<string, string> = {
      equals: '===',
      notEquals: '!==',
      contains: '.includes',
      doesNotContain: '!.includes',
      startsWith: '.startsWith',
      endsWith: '.endsWith',
      greater: '>',
      less: '<',
      greaterOrEquals: '>=',
      lessOrEquals: '<=',
      regex: '.match',
    };

    const operator = operatorMap[operation] || '===';

    if (operator.startsWith('.')) {
      const method = operator.substring(1);
      if (operator.startsWith('!')) {
        return `!${leftValue}.${method.substring(1)}(${rightValue})`;
      }
      return `${leftValue}.${method}(${rightValue})`;
    }

    return `${leftValue} ${operator} ${rightValue}`;
  }

  private transformValue(value: any): string {
    if (typeof value !== 'string') {
      return JSON.stringify(value);
    }

    if (this.expressionParser.hasExpressions(value)) {
      return this.expressionParser.transformTemplate(value);
    }

    if (value.startsWith('$json.')) {
      return `context.items[0].json.${value.substring(6)}`;
    }

    return `'${value}'`;
  }
}

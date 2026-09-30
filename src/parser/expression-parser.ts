/**
 * Expression parser for n8n {{ }} syntax using Acorn AST
 */

import { Parser } from 'acorn';
import { generate } from 'astring';
import type { ExpressionTransform } from '../types.js';

export class ExpressionParser {
  /**
   * Extract all {{  }} expressions from a string
   * Handles both {{ }} and ={{ }} formats
   */
  extractExpressions(template: string): Array<{
    full: string;
    expression: string;
    start: number;
    end: number;
  }> {
    const regex = /=?\{\{([^}]+)\}\}/g;
    const expressions: Array<{
      full: string;
      expression: string;
      start: number;
      end: number;
    }> = [];
    let match;

    while ((match = regex.exec(template)) !== null) {
      expressions.push({
        full: match[0],
        expression: match[1].trim(),
        start: match.index,
        end: match.index + match[0].length,
      });
    }

    return expressions;
  }

  /**
   * Transform an n8n expression to valid TypeScript
   */
  transformExpression(expression: string): ExpressionTransform {
    try {
      const ast = Parser.parse(expression, {
        ecmaVersion: 'latest' as any,
        sourceType: 'script',
      });

      const variables: string[] = [];

      this.walkAST(ast, (node: any) => {
        if (node.type === 'Identifier') {
          if (node.name === '$json') {
            node.name = 'context.items[0].json';
            variables.push('context.items');
          } else if (node.name === '$items') {
            node.name = 'context.items';
            variables.push('context.items');
          } else if (node.name === '$now') {
            Object.assign(node, {
              type: 'CallExpression',
              callee: {
                type: 'MemberExpression',
                object: { type: 'Identifier', name: 'Date' },
                property: { type: 'Identifier', name: 'now' },
                computed: false,
              },
              arguments: [],
            });
          }
        }

        if (node.type === 'CallExpression' && node.callee?.name === '$') {
          if (
            node.arguments.length > 0 &&
            node.arguments[0].type === 'Literal'
          ) {
            const nodeName = node.arguments[0].value;
            variables.push(`context.nodeOutputs['${nodeName}']`);

            Object.assign(node, {
              type: 'MemberExpression',
              object: { type: 'Identifier', name: 'context.nodeOutputs' },
              property: { type: 'Literal', value: nodeName },
              computed: true,
            });
          }
        }

        if (
          node.type === 'MemberExpression' &&
          node.object?.name === '$node'
        ) {
          if (node.property.type === 'Literal') {
            const nodeName = node.property.value;
            variables.push(`context.nodeOutputs['${nodeName}']`);

            Object.assign(node, {
              object: { type: 'Identifier', name: 'context.nodeOutputs' },
              property: { type: 'Literal', value: nodeName },
              computed: true,
            });
          }
        }
      });

      const transformed = generate(ast);

      return {
        original: expression,
        transformed,
        variables: Array.from(new Set(variables)),
      };
    } catch (error) {
      return {
        original: expression,
        transformed: expression,
        variables: [],
      };
    }
  }

  /**
   * Transform a full template string containing expressions
   */
  transformTemplate(template: string): string {
    const expressions = this.extractExpressions(template);

    if (expressions.length === 0) {
      return `'${template}'`;
    }

    if (
      expressions.length === 1 &&
      expressions[0].start === 0 &&
      expressions[0].end === template.length
    ) {
      const transformed = this.transformExpression(expressions[0].expression);
      return this.cleanInlineExpression(transformed.transformed);
    }

    let result = template;
    let offset = 0;

    for (const expr of expressions) {
      const transformed = this.transformExpression(expr.expression);

      const originalLength = expr.full.length;
      const cleanExpr = this.cleanInlineExpression(transformed.transformed);
      const replacement = `\${${cleanExpr}}`;

      result =
        result.slice(0, expr.start + offset) +
        replacement +
        result.slice(expr.end + offset);

      offset += replacement.length - originalLength;
    }

    return '`' + result + '`';
  }

  private cleanInlineExpression(expr: string): string {
    return expr
      .trim()
      .split('\n')
      .map(line => line.trim())
      .join(' ')
      .replace(/;\s*$/g, '');
  }

  private walkAST(node: any, callback: (node: any) => void): void {
    callback(node);

    for (const key in node) {
      if (node[key] && typeof node[key] === 'object') {
        if (Array.isArray(node[key])) {
          node[key].forEach((child: any) => {
            if (child && typeof child === 'object' && child.type) {
              this.walkAST(child, callback);
            }
          });
        } else if (node[key].type) {
          this.walkAST(node[key], callback);
        }
      }
    }
  }

  hasExpressions(value: any): boolean {
    if (typeof value !== 'string') return false;
    return /=?\{\{.+?\}\}/.test(value);
  }

  transformParameters(params: Record<string, any>): Record<string, any> {
    const result: Record<string, any> = {};

    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string' && this.hasExpressions(value)) {
        result[key] = this.transformTemplate(value);
      } else if (typeof value === 'object' && value !== null) {
        result[key] = this.transformParameters(value);
      } else {
        result[key] = value;
      }
    }

    return result;
  }
}

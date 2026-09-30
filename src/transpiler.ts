/**
 * Transpiler orchestrator — thin wrapper over parser + codegen pipeline.
 * No filesystem access; pure in-memory transformation.
 */

import { WorkflowParser } from './parser/workflow-parser.js';
import { WorkerGeneratorV2 } from './codegen/worker-generator-v2.js';
import type {
  N8nWorkflow,
  IRWorkflow,
  TranspiledFile,
  TranspileResponse,
  TranspileSummary,
} from './types.js';

export class N8nTranspiler {
  private parser = new WorkflowParser();
  private generator = new WorkerGeneratorV2();

  /**
   * Transpile n8n workflow JSON into scaffold-ready files[].
   */
  transpile(workflow: N8nWorkflow): TranspileResponse {
    // Phase 1: Parse n8n JSON into IR
    const ir = this.parser.parse(workflow);

    // Validate
    const warnings = this.validate(ir);

    // Phase 2: Generate Worker code
    const generated = this.generator.generate(ir);

    // Build files array (scaffold_publish compatible)
    const files: TranspiledFile[] = [
      { path: 'src/index.ts', content: generated.indexTs },
      { path: 'wrangler.toml', content: generated.wranglerToml },
      { path: 'README.md', content: generated.readme },
      { path: 'package.json', content: this.generatePackageJson(ir) },
      { path: 'tsconfig.json', content: this.generateTsConfig() },
    ];

    const summary = this.buildSummary(ir, warnings);

    return { files, summary };
  }

  private validate(ir: IRWorkflow): string[] {
    const warnings: string[] = [];

    const unsupported = ir.nodes.filter((n) => n.semanticType === 'unsupported');
    if (unsupported.length > 0) {
      warnings.push(
        `${unsupported.length} unsupported node(s): ${unsupported.map((n) => `${n.name} (${n.originalType})`).join(', ')}`
      );
    }

    const codeNodes = ir.nodes.filter((n) => n.semanticType === 'code');
    if (codeNodes.length > 0) {
      warnings.push(
        `${codeNodes.length} Code node(s) require manual implementation`
      );
    }

    const nodesWithMissingCreds = ir.nodes.filter(
      (n) =>
        (n.semanticType === 'http-request' ||
          n.semanticType === 'database' ||
          n.semanticType === 'ai') &&
        !n.credentialRef
    );

    if (nodesWithMissingCreds.length > 0) {
      warnings.push(
        `${nodesWithMissingCreds.length} node(s) missing credentials: ${nodesWithMissingCreds.map((n) => n.name).join(', ')}`
      );
    }

    return warnings;
  }

  private buildSummary(ir: IRWorkflow, warnings: string[]): TranspileSummary & { warnings?: string[] } {
    const supported = ir.nodes.filter(
      (n) => n.semanticType !== 'unsupported' && n.semanticType !== 'code'
    );

    return {
      workflowName: ir.name,
      totalNodes: ir.nodes.length,
      supportedNodes: supported.length,
      unsupportedNodes: ir.nodes.filter((n) => n.semanticType === 'unsupported').length,
      resources: {
        secrets: ir.resources.secrets.length,
        databases: ir.resources.databases.length,
        ai: ir.resources.ai,
        queues: ir.resources.queues.length,
        cronTriggers: ir.resources.cronTriggers.length,
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  private generatePackageJson(ir: IRWorkflow): string {
    const name = ir.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    return JSON.stringify(
      {
        name,
        version: '0.1.0',
        private: true,
        type: 'module',
        scripts: {
          dev: 'wrangler dev',
          deploy: 'wrangler deploy',
          'deploy:staging': 'wrangler deploy --env staging',
          'deploy:production': 'wrangler deploy --env production',
          typecheck: 'tsc --noEmit',
        },
        dependencies: {
          hono: '^4.10.4',
        },
        devDependencies: {
          '@cloudflare/workers-types': '^4.20251014.0',
          typescript: '^5.3.3',
          wrangler: '^4.0.0',
        },
      },
      null,
      2
    );
  }

  private generateTsConfig(): string {
    return JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ES2022',
          lib: ['ES2022'],
          moduleResolution: 'bundler',
          types: ['@cloudflare/workers-types'],
          outDir: './dist',
          rootDir: './src',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          forceConsistentCasingInFileNames: true,
          resolveJsonModule: true,
          declaration: true,
          sourceMap: true,
          noEmit: true,
        },
        include: ['src/**/*'],
        exclude: ['node_modules', 'dist'],
      },
      null,
      2
    );
  }
}

/*
 * ---------------------------------------------------------------------------
 * Phase 1 — experimental TypeScript 7 (tsgo) backend for jsii.
 *
 * Emit pipeline: produce the JS / d.ts artifacts via the patched TS7
 * `program.getEmitOutput`, then run the jsii runtime-type-information (rtti)
 * post-emit pass that injects the `Symbol.for("jsii.rtti")` marker onto each
 * exported class. This mirrors what strada does with a `CustomTransformer`
 * (src/transforms/runtime-info.ts), but as a post-emit text pass over the
 * emitted `.js` — the approach validated in `poc/typescript7/emit-demo.sh`
 * (rtti verified byte-identical to strada at runtime on constructs).
 *
 * Out of scope for Phase 1 (see PHASE1-RESULTS.md): the `.warnings.jsii.js`
 * generation (deprecation-warnings) and the deprecated-remover emit surgery.
 * ---------------------------------------------------------------------------
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as spec from '@jsii/spec';

import { Ts7Project } from './ts7-host';

export interface Ts7EmitPipelineOptions {
  readonly projectRoot: string;
  readonly assembly: spec.Assembly;
}

export interface Ts7EmitPipelineResult {
  readonly emittedFiles: string[];
}

/** The jsii runtime-type-information symbol key (see @jsii/runtime). */
const RTTI_SYMBOL = 'jsii.rtti';

/**
 * Emit JS/d.ts for every local source file via `getEmitOutput`, writing the
 * results to disk and injecting jsii rtti into the emitted `.js` files.
 */
export function runTs7EmitPipeline(
  project: Ts7Project,
  options: Ts7EmitPipelineOptions,
): Ts7EmitPipelineResult {
  const { program } = project;
  const root = options.projectRoot;
  const assembly = options.assembly;

  // Map absolute source-file path -> [{ name, fqn }] of exported classes declared
  // there, so we can inject rtti into that file's emitted `.js`.
  const classesBySourceFile = new Map<string, Array<{ name: string; fqn: string }>>();
  for (const [fqn, type] of Object.entries(assembly.types ?? {})) {
    if ((type as any).kind !== spec.TypeKind.Class) {
      continue;
    }
    const rel = (type as any).locationInModule?.filename;
    if (!rel) {
      continue;
    }
    const abs = path.resolve(root, rel);
    if (!classesBySourceFile.has(abs)) {
      classesBySourceFile.set(abs, []);
    }
    classesBySourceFile.get(abs)!.push({ name: (type as any).name, fqn });
  }

  const emittedFiles: string[] = [];

  // The TS7 program handle exposes getSourceFileNames() (not getSourceFiles()).
  const sourceFileNames: string[] = program.getSourceFileNames();
  for (const fileName of sourceFileNames) {
    // Only emit local, non-declaration source files.
    if (!fileName.startsWith(root) || fileName.includes('node_modules') || /\.d\.ts$/.test(fileName)) {
      continue;
    }

    const sf = program.getSourceFile(fileName);
    if (!sf) {
      continue;
    }

    const emitOutput = program.getEmitOutput(sf);
    if (!emitOutput || !emitOutput.outputFiles) {
      continue;
    }

    const classesHere = classesBySourceFile.get(fileName);

    for (const out of emitOutput.outputFiles) {
      let text: string = out.text;

      // Inject rtti into the JS output for classes declared in this source file.
      if (classesHere && classesHere.length && /\.js$/.test(out.name) && !/\.d\.ts$/.test(out.name)) {
        text += rttiSnippet(classesHere, assembly.version);
      }

      const outPath = path.resolve(root, out.name);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, text, { encoding: 'utf8' });
      emittedFiles.push(outPath);
    }
  }

  return { emittedFiles };
}

/**
 * Build the post-emit rtti injection snippet for a set of classes, matching the
 * shape strada's runtime-info transformer produces at runtime.
 */
function rttiSnippet(classes: Array<{ name: string; fqn: string }>, version: string): string {
  let snippet = '\n// jsii runtime type information (injected by the ts7 backend, post-emit)\n';
  for (const c of classes) {
    snippet +=
      `try { Object.defineProperty(exports.${c.name}, Symbol.for("${RTTI_SYMBOL}"), ` +
      `{ value: { fqn: ${JSON.stringify(c.fqn)}, version: ${JSON.stringify(version)} }, configurable: true }); } catch (e) { }\n`;
  }
  return snippet;
}

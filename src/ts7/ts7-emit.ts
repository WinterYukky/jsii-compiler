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
  /** tsc `outDir` from the jsii config (for mapping source -> emitted js path). */
  readonly outDir?: string;
  /** tsc `rootDir` from the jsii config. */
  readonly rootDir?: string;
}

export interface Ts7EmitPipelineResult {
  readonly emittedFiles: string[];
}

/** The jsii runtime-type-information symbol key (see @jsii/runtime). */
const RTTI_SYMBOL = 'jsii.rtti';

/**
 * Emit JS/d.ts for the whole project in a SINGLE `getEmitOutput()` call, writing
 * the results to disk and injecting jsii rtti into the emitted `.js` files.
 *
 * NOTE (perf/stability): emitting per-source-file (calling `getEmitOutput(sf)`
 * once per file) issues one RPC round-trip per file and, at aws-cdk-lib scale
 * (~thousands of files), destabilizes the out-of-process tsgo session (observed
 * EPIPE / process exit). The API supports a whole-project emit when called with
 * no target file (Go side emits in parallel and collects under a mutex), which
 * collapses this to one RPC. This is also a useful design data point for the
 * upstream API. See PHASE1-RESULTS.md.
 */
export function runTs7EmitPipeline(
  project: Ts7Project,
  options: Ts7EmitPipelineOptions,
): Ts7EmitPipelineResult {
  const { program } = project;
  const root = options.projectRoot;
  const assembly = options.assembly;

  // Map the emitted `.js` path (relative to root, normalized) -> classes to stamp
  // with rtti. Derive the emitted path from each class's source `locationInModule`
  // via the tsc outDir/rootDir transform, so it is robust to duplicate basenames
  // across modules (common at aws-cdk-lib scale). We also index by basename as a
  // fallback for simple layouts.
  const classesByJsRel = new Map<string, Array<{ name: string; fqn: string }>>();
  const classesByJsBasename = new Map<string, Array<{ name: string; fqn: string }>>();
  for (const [fqn, type] of Object.entries(assembly.types ?? {})) {
    if ((type as any).kind !== spec.TypeKind.Class) {
      continue;
    }
    const relSrc: string | undefined = (type as any).locationInModule?.filename;
    if (!relSrc) {
      continue;
    }
    const entry = { name: (type as any).name, fqn };
    const jsRel = sourceRelToJsRel(relSrc, options.outDir, options.rootDir);
    if (!classesByJsRel.has(jsRel)) {
      classesByJsRel.set(jsRel, []);
    }
    classesByJsRel.get(jsRel)!.push(entry);
    const base = path.basename(jsRel);
    if (!classesByJsBasename.has(base)) {
      classesByJsBasename.set(base, []);
    }
    classesByJsBasename.get(base)!.push(entry);
  }

  const emittedFiles: string[] = [];

  // Single whole-project emit (no target source file).
  const emitOutput = program.getEmitOutput();
  if (!emitOutput || !emitOutput.outputFiles) {
    return { emittedFiles };
  }

  for (const out of emitOutput.outputFiles) {
    const outPath = path.resolve(root, out.name);
    let text: string = out.text;

    if (/\.js$/.test(out.name)) {
      const jsRel = normalizeRel(path.relative(root, outPath));
      let classesHere = classesByJsRel.get(jsRel);
      if (!classesHere) {
        // fallback for simple layouts where the rel-path transform didn't line up
        classesHere = classesByJsBasename.get(path.basename(out.name));
      }
      if (classesHere && classesHere.length) {
        text += rttiSnippet(classesHere, assembly.version);
      }
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, text, { encoding: 'utf8' });
    emittedFiles.push(outPath);
  }

  return { emittedFiles };
}

/** Normalize a relative path for use as a map key (posix separators). */
function normalizeRel(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Transform a source path (relative to root, e.g. `src/foo.ts`) into the emitted
 * JS path (relative to root, e.g. `lib/foo.js`) using the tsc outDir/rootDir.
 */
function sourceRelToJsRel(relSrc: string, outDir?: string, rootDir?: string): string {
  let p = relSrc.replace(/\.tsx?$/, '.js');
  if (rootDir != null && outDir != null) {
    const rootRel = normalizeRel(path.relative(rootDir, p));
    if (!rootRel.startsWith('..')) {
      p = path.join(outDir, rootRel);
    }
  }
  return normalizeRel(p);
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

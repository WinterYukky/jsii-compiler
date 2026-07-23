/*
 * ---------------------------------------------------------------------------
 * Phase 1 — experimental TypeScript 7 (tsgo) backend for jsii.
 *
 * Public entry point for the ts7 backend, enabled with JSII_COMPILER_BACKEND=ts7.
 * Wires the Ts7Host (API session) -> Ts7Assembler (TS7-native .jsii generation)
 * -> assembly write (reusing @jsii/spec's writeAssembly for format parity,
 * including the compressed file-redirect form).
 *
 * Diagnostics / negative-path handling are OUT OF SCOPE for Phase 1 (see
 * ts7/assembler.ts header).
 * ---------------------------------------------------------------------------
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as spec from '@jsii/spec';
import { writeAssembly } from '@jsii/spec';

import { Ts7Assembler } from './assembler';
import { runTs7EmitPipeline } from './ts7-emit';
import { Ts7Host } from './ts7-host';

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const sortJson = require('sort-json');

/** The environment variable that selects the experimental backend. */
export const TS7_BACKEND_ENV = 'JSII_COMPILER_BACKEND';

/** Returns true when the ts7 backend has been requested via the env var. */
export function isTs7BackendEnabled(): boolean {
  return (process.env[TS7_BACKEND_ENV] ?? '').toLowerCase() === 'ts7';
}

export interface Ts7EmitOptions {
  readonly projectRoot: string;
  readonly stripDeprecated?: boolean;
  readonly stripDeprecatedAllowListFile?: string;
  readonly compressAssembly?: boolean;
}

export interface Ts7EmitResult {
  readonly assembly: spec.Assembly;
  readonly typeCount: number;
  readonly emittedFiles: string[];
}

/**
 * Derive the entrypoint .ts from the package.json `types`/`main` fields.
 *
 * Mirrors the strada Assembler's `mainFile` computation: start from the declared
 * `types` (or `main`), turn the `.d.ts`/`.js` into `.ts`, then — if an
 * out-of-source build is configured (tsc `outDir`) — re-root the path from the
 * `outDir` into the `rootDir`. This correctly handles both conventional
 * `src`->`lib` layouts and in-place (`rootDir === outDir`) layouts.
 */
function deriveEntry(projectRoot: string, pkg: any): string {
  const dts: string = pkg.types ?? pkg.main ?? 'index.d.ts';
  let mainFile = dts.replace(/\.d\.ts(x?)$/, '.ts$1').replace(/\.js$/, '.ts');

  const tsc = pkg.jsii?.tsc ?? {};
  const outDir: string | undefined = tsc.outDir;
  const rootDir: string | undefined = tsc.rootDir;
  if (outDir != null) {
    // strip the outDir prefix, then prepend rootDir (if any)
    const rel = path.relative(outDir, mainFile);
    mainFile = rootDir != null ? path.join(rootDir, rel) : rel;
  }
  return path.resolve(projectRoot, mainFile);
}

/**
 * Run the ts7 backend for a package: produce and write the `.jsii` assembly.
 */
export async function ts7Emit(options: Ts7EmitOptions): Promise<Ts7EmitResult> {
  const { projectRoot } = options;
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const entry = deriveEntry(projectRoot, pkg);

  const host = await Ts7Host.open(projectRoot);
  try {
    const project = host.getProject();
    const assembler = new Ts7Assembler(host.np, project, {
      packageJson: pkg,
      projectRoot,
      entry,
      assemblyName: pkg.name,
      defaultStability: pkg.stability,
      stripDeprecated: options.stripDeprecated ?? !!pkg['cdk-build']?.stripDeprecated,
      stripDeprecatedAllowListFile: options.stripDeprecatedAllowListFile,
    });

    const assembly = assembler.assemble();

    // Write the assembly first (the parity artifact), reusing @jsii/spec's writer
    // so the on-disk format (incl. the compressed file-redirect variant) is
    // byte-for-byte compatible with the strada path.
    writeAssembly(projectRoot, fingerprint(assembly), { compress: options.compressAssembly ?? false });

    // Then emit JS/d.ts via getEmitOutput and inject jsii rtti (post-emit pass).
    // Emit is best-effort: a failure here (e.g. an unstable out-of-process tsgo
    // session on a very large project) must not discard the assembly we already
    // produced.
    let emittedFiles: string[] = [];
    try {
      ({ emittedFiles } = runTs7EmitPipeline(project, {
        projectRoot,
        assembly,
        outDir: pkg.jsii?.tsc?.outDir,
        rootDir: pkg.jsii?.tsc?.rootDir,
      }));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`ts7 backend: emit pipeline failed (assembly was still written): ${(err as Error).message}`);
    }

    return { assembly, typeCount: Object.keys(assembly.types ?? {}).length, emittedFiles };
  } finally {
    host.close();
  }
}

/** Mirror of strada `_fingerprint`: sort keys, hash, stamp `fingerprint`. */
function fingerprint(assembly: spec.Assembly): spec.Assembly {
  delete (assembly as any).fingerprint;
  const sorted = sortJson(assembly);
  const hash = crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('base64');
  return { ...sorted, fingerprint: hash };
}

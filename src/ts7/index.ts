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
}

/** Derive the entrypoint .ts from the package.json `types`/`main` fields. */
function deriveEntry(projectRoot: string, pkg: any): string {
  const dts = pkg.types ?? pkg.main ?? 'index.d.ts';
  const rel = dts
    .replace(/\.d\.ts(x?)$/, '.ts$1')
    .replace(/\.js$/, '.ts')
    .replace(/^lib\//, 'src/');
  return path.resolve(projectRoot, rel);
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

    // Reuse @jsii/spec's writer so the on-disk format (incl. the compressed
    // file-redirect variant) is byte-for-byte compatible with the strada path.
    writeAssembly(projectRoot, fingerprint(assembly), { compress: options.compressAssembly ?? false });

    return { assembly, typeCount: Object.keys(assembly.types ?? {}).length };
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

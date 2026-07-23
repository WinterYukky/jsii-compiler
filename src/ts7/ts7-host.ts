/*
 * ---------------------------------------------------------------------------
 * Phase 1 — experimental TypeScript 7 (tsgo) backend for jsii.
 *
 * `Ts7Host` is the thin adapter that owns everything that differs between the
 * classic in-process "Strada" compiler and the out-of-process TS7 API:
 *   - API session / snapshot lifecycle (open project -> program + checker)
 *   - the post-emit pipeline for `getEmitOutput` (implemented in ts7-emit.ts)
 *
 * Per the approved Phase 1 architecture decision (see PORT-ANALYSIS.md §5), this
 * host does NOT try to make the TS7 program/checker look like `ts.Program` /
 * `ts.TypeChecker`. Wrapping every AST node to fake the classic object shapes
 * would break `node-bindings` WeakMap identity and add overhead. Instead the
 * TS7-native assembler (ts7/assembler.ts) reads the raw TS7 objects directly.
 * The eventual unification with the strada Assembler is a Phase 2 decision, to
 * be made from parity data.
 * ---------------------------------------------------------------------------
 */
import * as path from 'node:path';

import { loadNativePreview, NativePreview } from './native-preview';

export interface Ts7Project {
  /** The raw TS7 `Program` handle. */
  readonly program: any;
  /** The raw TS7 `TypeChecker` handle. */
  readonly checker: any;
}

/**
 * Owns a single TS7 API session and the snapshot opened for a project.
 */
export class Ts7Host {
  private constructor(
    public readonly np: NativePreview,
    private readonly api: any,
    private readonly snapshot: any,
    public readonly tsconfigPath: string,
  ) {}

  /**
   * Open an API session against `projectRoot`/`tsconfig.json` and return a host
   * bound to the resulting program + checker.
   */
  public static async open(projectRoot: string, tsconfigFileName = 'tsconfig.json'): Promise<Ts7Host> {
    const np = await loadNativePreview();
    const tsconfigPath = path.join(projectRoot, tsconfigFileName);

    const api = new np.API({ cwd: projectRoot, tsserverPath: np.tsgoPath });
    const snapshot = api.updateSnapshot({ openProjects: [tsconfigPath] });

    return new Ts7Host(np, api, snapshot, tsconfigPath);
  }

  /** The program + checker for the opened project. */
  public getProject(): Ts7Project {
    const project = this.snapshot.getProject(this.tsconfigPath);
    if (!project) {
      throw new Error(`TS7 project not found for ${this.tsconfigPath}`);
    }
    return { program: project.program, checker: project.checker };
  }

  /** Dispose the snapshot and close the API session / tsgo process. */
  public close(): void {
    // Tolerate a channel that is already gone (e.g. the tsgo process exited):
    // dispose/close can throw EPIPE, which must not mask the real result.
    try {
      this.snapshot.dispose();
    } catch {
      /* ignore */
    }
    try {
      this.api.close();
    } catch {
      /* ignore */
    }
  }
}

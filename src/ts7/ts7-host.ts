/*
 * ---------------------------------------------------------------------------
 * Experimental TypeScript 7 (tsgo) backend for jsii.
 *
 * `Ts7Host` is the thin adapter that owns everything that differs between the
 * classic in-process compiler and the out-of-process TypeScript 7 API:
 *   - API session / snapshot lifecycle (open project -> program + checker)
 *   - the post-emit pipeline for `program.emit()` (implemented in ts7-emit.ts)
 *
 * Per the architecture decision recorded in README.md (this directory), this
 * host does NOT try to make the TS7 program/checker look like `ts.Program` /
 * `ts.TypeChecker`. Wrapping every AST node to fake the classic object shapes
 * would break `node-bindings` WeakMap identity and add overhead. Instead the
 * TS7-native assembler (ts7/assembler.ts) reads the raw TS7 objects directly.
 * Whether/how to unify with the classic Assembler is a follow-up decision, to
 * be made from parity data.
 * ---------------------------------------------------------------------------
 */
import * as path from 'node:path';

import { loadTs7Api, Ts7Api } from './ts7-api';

export interface Ts7Project {
  /** The raw TS7 `Program` handle. */
  readonly program: any;
  /** The raw TS7 `TypeChecker` handle. */
  readonly checker: any;
  /** The owning `API` session (exposes `batch()` for multi-request round-trips). */
  readonly api: any;
}

/**
 * Owns a single TS7 API session and the snapshot opened for a project.
 */
export class Ts7Host {
  /**
   * Open an API session against `projectRoot`/`tsconfig.json` and return a host
   * bound to the resulting program + checker.
   */
  public static async open(projectRoot: string, tsconfigFileName = 'tsconfig.json'): Promise<Ts7Host> {
    const ts7 = await loadTs7Api(projectRoot);
    const tsconfigPath = path.join(projectRoot, tsconfigFileName);

    // collectTiming lets us report RPC request counts / bytes for perf work
    // (opt-in via JSII_TS7_TIMING; negligible overhead but off by default).
    const collectTiming = !!process.env.JSII_TS7_TIMING;
    const api = new ts7.API({ cwd: projectRoot, collectTiming });
    const snapshot = api.createSnapshot({ openProjects: [tsconfigPath] });

    return new Ts7Host(ts7, api, snapshot, tsconfigPath);
  }

  /**
   * SPIKE: open an `typescript/async` session (JSII_TS7_ASYNC=1). Same object
   * model as the sync API but every call returns a promise, and requests issued
   * in the same macrotask are coalesced into one `batchRequests` round-trip.
   */
  public static async openAsync(projectRoot: string, tsconfigFileName = 'tsconfig.json'): Promise<Ts7Host> {
    const ts7 = await loadTs7Api(projectRoot);
    const tsconfigPath = path.join(projectRoot, tsconfigFileName);
    const collectTiming = !!process.env.JSII_TS7_TIMING;
    const api = new ts7.AsyncAPI({ cwd: projectRoot, collectTiming });
    const snapshot = await api.createSnapshot({ openProjects: [tsconfigPath] });
    return new Ts7Host(ts7, api, snapshot, tsconfigPath, true);
  }

  private constructor(
    public readonly ts7: Ts7Api,
    private readonly api: any,
    private readonly snapshot: any,
    public readonly tsconfigPath: string,
    /** SPIKE: true when opened with the async API (every API call returns a promise). */
    public readonly isAsync: boolean = false,
  ) {}

  /** SPIKE: async-API counterpart of `getTimingInfo` (the async client returns a promise). */
  public async getTimingInfoAsync(): Promise<any> {
    try {
      return await this.api.getTimingInfo();
    } catch {
      return undefined;
    }
  }

  /** SPIKE: close for the async API (dispose + close are promises there). */
  public async closeAsync(): Promise<void> {
    try {
      await this.snapshot.dispose();
    } catch {
      /* ignore */
    }
    try {
      await this.api.close();
    } catch {
      /* ignore */
    }
  }

  /** RPC timing info (requestCount/bytes) when JSII_TS7_TIMING is enabled. */
  public getTimingInfo(): any {
    try {
      return this.api.getTimingInfo();
    } catch {
      return undefined;
    }
  }

  /** The program + checker for the opened project. */
  public getProject(): Ts7Project {
    const project = this.snapshot.getConfiguredProject(this.tsconfigPath);
    if (!project) {
      throw new Error(`TS7 project not found for ${this.tsconfigPath}`);
    }
    return { program: project.program, checker: project.checker, api: this.api };
  }

  /** Dispose the snapshot and close the API session / native process. */
  public close(): void {
    // Tolerate a channel that is already gone (e.g. the server process exited):
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

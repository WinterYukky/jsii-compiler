/*
 * Measurement preload for the jsii ts7 backend (research use only).
 *
 *   NODE_OPTIONS="--require /path/to/rpc-hook.cjs" JSII_PERF_OUT=/tmp/x.json jsii ...
 *
 * Hooks the TypeScript 7 sync API client at three layers so the per-method cost
 * can be split without touching the typescript package:
 *   requestBytesSync : write + wait for the full response (server + pipe)      -> rpcNs
 *   requestSync      : + Buffer -> string UTF-8 decode                         -> utf8Ns = total - rpcNs
 *   apiRequest       : + JSON.stringify(params) + JSON.parse(result)           -> jsonNs = total - requestSync
 * Optional sampled server time: every K-th request (JSII_PERF_SERVER_SAMPLE=K) asks
 * the server for its own processing time of the request just completed.
 * Phase marks: globalThis.__legePerfMark(name) (called from the patched ts7/index.ts).
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const T0 = process.hrtime.bigint();
const out = process.env.JSII_PERF_OUT;
const sampleEvery = Number(process.env.JSII_PERF_SERVER_SAMPLE ?? 0);
const perMethod = new Map();
const marks = [];
let totalRequests = 0;
let hookedAt;
let serverTotals;
// JSII_PERF_DEDUP=1: per-method set of distinct request params (input keys), to size an input-keyed cache.
const dedup = process.env.JSII_PERF_DEDUP ? new Map() : undefined;
// Caller stacks for the heavy source-file fetches (who pulls whole source files across the pipe?).
const sfCallers = new Map();
const STACK_METHODS = new Set(['getCachedSourceFile', 'getSourceFile', 'getExportsOfModule']);
function recordCaller(method) {
  const lines = new Error().stack.split('\n').slice(2);
  const frames = [];
  for (const l of lines) {
    if (l.includes('rpc-hook.cjs')) continue;
    const m = /at (.*?) \((.*?):(\d+):\d+\)|at (.*?):(\d+):\d+/.exec(l);
    if (!m) continue;
    const fn = m[1] ?? '(anon)';
    const file = (m[2] ?? m[4] ?? '').replace(/.*\/node_modules\//, '').replace(/.*jsii-compiler\//, '').replace(/^file:\/\//, '');
    frames.push(`${fn} ${file}:${m[3] ?? m[5]}`);
    if (frames.length >= 7) break;
  }
  const key = `${method} <- ${frames.join(' <- ')}`;
  sfCallers.set(key, (sfCallers.get(key) ?? 0) + 1);
}

function stat(method) {
  let s = perMethod.get(method);
  if (!s) {
    s = { method, count: 0, rpcNs: 0n, utf8Ns: 0n, jsonNs: 0n, sent: 0, recv: 0, maxRecv: 0, serverSamples: 0, serverMs: 0 };
    perMethod.set(method, s);
  }
  return s;
}

globalThis.__legePerfMark = (name) => {
  marks.push({ name, ms: Number(process.hrtime.bigint() - T0) / 1e6, requests: totalRequests });
};

function resolveTs7Dir() {
  if (process.env.JSII_TS7_TYPESCRIPT) return process.env.JSII_TS7_TYPESCRIPT;
  const base = process.env.JSII_PERF_COMPILER_DIR ?? process.cwd();
  return path.dirname(require.resolve('typescript7/package.json', { paths: [base] }));
}

const ts7Dir = resolveTs7Dir();
globalThis.__legePerfReady = (async () => {
  const chan = await import(pathToFileURL(path.join(ts7Dir, 'dist/api/syncChannel.js')).href);
  const cli = await import(pathToFileURL(path.join(ts7Dir, 'dist/api/sync/client.js')).href);
  const CP = chan.SyncRpcChannel.prototype;
  const KP = cli.Client.prototype;

  let depth = 0; // nested calls (sampled getServerTiming) must not be counted
  let lastRpcNs = 0n;
  let lastSyncNs = 0n;

  const origBytes = CP.requestBytesSync;
  CP.requestBytesSync = function (method, payload) {
    if (depth > 0) return origBytes.call(this, method, payload);
    const t = process.hrtime.bigint();
    const res = origBytes.call(this, method, payload);
    const dt = process.hrtime.bigint() - t;
    totalRequests++;
    const s = stat(method);
    s.count++;
    s.rpcNs += dt;
    lastRpcNs = dt;
    const sent = typeof payload === 'string' ? Buffer.byteLength(payload) : payload.length;
    s.sent += sent;
    s.recv += res.length;
    if (res.length > s.maxRecv) s.maxRecv = res.length;
    if (sampleEvery > 0 && totalRequests % sampleEvery === 0) {
      depth++;
      try {
        const st = JSON.parse(origBytes.call(this, 'getServerTiming', '').toString('utf-8'));
        const recent = st.recentRequests ?? [];
        const last = recent[recent.length - 1];
        if (last && last.method === method) {
          s.serverSamples++;
          s.serverMs += last.processingTimeMs;
        }
      } catch {
        /* ignore sampling failures */
      } finally {
        depth--;
      }
    }
    return res;
  };

  // JSII_PERF_MEMO=1: experiment — memoize the raw response of idempotent checker
  // queries by (method, params). Valid because the snapshot's program is immutable.
  const MEMO_METHODS = new Set(
    (process.env.JSII_PERF_MEMO_METHODS ?? 'getTypeAtLocation,getTypeArguments,getPropertyOfType,getAliasedSymbol,getSymbolAtLocation').split(','),
  );
  const memo = process.env.JSII_PERF_MEMO ? new Map() : undefined;
  let memoHits = 0;
  const origSync = CP.requestSync;
  CP.requestSync = function (method, payload) {
    if (depth > 0) return origSync.call(this, method, payload);
    if (memo && MEMO_METHODS.has(method)) {
      const key = method + '\0' + payload;
      const hit = memo.get(key);
      if (hit !== undefined) {
        memoHits++;
        return hit;
      }
      const res = origSync.call(this, method, payload);
      memo.set(key, res);
      return res;
    }
    const t = process.hrtime.bigint();
    const res = origSync.call(this, method, payload);
    const dt = process.hrtime.bigint() - t;
    lastSyncNs = dt;
    stat(method).utf8Ns += dt - lastRpcNs;
    return res;
  };

  const origApiBin = KP.apiRequestBinary;
  KP.apiRequestBinary = function (method, params) {
    if (depth === 0 && STACK_METHODS.has(method)) recordCaller(method);
    return origApiBin.call(this, method, params);
  };
  const origApi = KP.apiRequest;
  KP.apiRequest = function (method, params) {
    if (depth > 0) return origApi.call(this, method, params);
    if (dedup) {
      let set = dedup.get(method);
      if (!set) dedup.set(method, (set = new Set()));
      set.add(JSON.stringify(params));
    }
    if (STACK_METHODS.has(method)) recordCaller(method);
    const t = process.hrtime.bigint();
    const res = origApi.call(this, method, params);
    const dt = process.hrtime.bigint() - t;
    stat(method).jsonNs += dt - lastSyncNs;
    return res;
  };
  const origClose = KP.close;
  KP.close = function () {
    try {
      depth++;
      serverTotals = JSON.parse(this.channel.requestSync('getServerTiming', '')).totals;
    } catch {
      /* server already gone */
    } finally {
      depth--;
    }
    return origClose.call(this);
  };
  process.on('exit', () => { globalThis.__legeMemoHits = memoHits; });
  hookedAt = Number(process.hrtime.bigint() - T0) / 1e6;
})();

function ms(ns) {
  return Math.round(Number(ns) / 1e4) / 100;
}

process.on('exit', () => {
  const rows = [...perMethod.values()]
    .map((s) => ({
      method: s.method,
      count: s.count,
      rpcMs: ms(s.rpcNs),
      utf8Ms: ms(s.utf8Ns),
      jsonMs: ms(s.jsonNs),
      sentBytes: s.sent,
      recvBytes: s.recv,
      avgRecvBytes: s.count ? Math.round(s.recv / s.count) : 0,
      maxRecvBytes: s.maxRecv,
      avgRpcUs: s.count ? Math.round(Number(s.rpcNs) / s.count / 10) / 100 : 0,
      serverSamples: s.serverSamples,
      serverMsSampled: Math.round(s.serverMs * 100) / 100,
      serverMsEstimate: s.serverSamples ? Math.round((s.serverMs / s.serverSamples) * s.count * 100) / 100 : null,
    }))
    .sort((a, b) => b.rpcMs - a.rpcMs);
  const totals = rows.reduce(
    (acc, r) => {
      acc.count += r.count;
      acc.rpcMs += r.rpcMs;
      acc.utf8Ms += r.utf8Ms;
      acc.jsonMs += r.jsonMs;
      acc.sentBytes += r.sentBytes;
      acc.recvBytes += r.recvBytes;
      if (r.serverMsEstimate != null) acc.serverMsEstimate += r.serverMsEstimate;
      return acc;
    },
    { count: 0, rpcMs: 0, utf8Ms: 0, jsonMs: 0, sentBytes: 0, recvBytes: 0, serverMsEstimate: 0 },
  );
  const wallMs = Number(process.hrtime.bigint() - T0) / 1e6;
    for (const r of rows) r.distinctParams = dedup?.get(r.method)?.size;
  const callers = [...sfCallers].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ n, stack: k }));
  const result = { wallMs, hookedAtMs: hookedAt, sampleEvery, totals, serverTotals, marks, methods: rows, callers, memoHits: globalThis.__legeMemoHits };
  if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2));
  const top = rows.slice(0, 12).map(
    (r) =>
      `${r.method.padEnd(32)} n=${String(r.count).padStart(7)} rpc=${String(r.rpcMs.toFixed(0)).padStart(6)}ms utf8=${String(
        r.utf8Ms.toFixed(0),
      ).padStart(5)}ms json=${String(r.jsonMs.toFixed(0)).padStart(5)}ms recv=${(r.recvBytes / 1e6).toFixed(1).padStart(7)}MB avg=${String(
        r.avgRecvBytes,
      ).padStart(7)}B srvEst=${r.serverMsEstimate == null ? '   n/a' : String(r.serverMsEstimate.toFixed(0)).padStart(6)}ms`,
  );
  process.stderr.write(
    `\n[lege-perf] wall=${wallMs.toFixed(0)}ms requests=${totals.count} rpc=${totals.rpcMs.toFixed(0)}ms utf8=${totals.utf8Ms.toFixed(
      0,
    )}ms json=${totals.jsonMs.toFixed(0)}ms recv=${(totals.recvBytes / 1e6).toFixed(1)}MB sent=${(totals.sentBytes / 1e6).toFixed(
      1,
    )}MB serverEst=${totals.serverMsEstimate.toFixed(0)}ms serverTotals=${JSON.stringify(serverTotals)} memoHits=${globalThis.__legeMemoHits}\n[lege-perf] marks: ${marks
      .map((m) => `${m.name}@${m.ms.toFixed(0)}ms(req ${m.requests})`)
      .join(' | ')}\n${top.join('\n')}\n`,
  );
});

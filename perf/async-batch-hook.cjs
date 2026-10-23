/*
 * Measurement preload for the typescript/async client (spike): records the size of
 * every coalesced batch (how many requests shared one round-trip), split by phase
 * (marks set via globalThis.__legePerfMark), plus per-phase wall time.
 *   node --require perf/async-batch-hook.cjs ... (JSII_PERF_OUT=/path/out.json)
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const T0 = process.hrtime.bigint();
const nowMs = () => Number(process.hrtime.bigint() - T0) / 1e6;
let phase = 'init';
const marks = [];
const phases = new Map(); // phase -> { batches, requests, singles, hist: Map<bucket,count>, rttMs }
function ph() {
  let p = phases.get(phase);
  if (!p) phases.set(phase, (p = { batches: 0, requests: 0, singles: 0, hist: new Map(), rttMs: 0 }));
  return p;
}
globalThis.__legePerfMark = (name) => {
  marks.push({ name, ms: nowMs() });
  phase = name;
};
function bucket(n) {
  if (n <= 1) return '1';
  if (n <= 4) return '2-4';
  if (n <= 16) return '5-16';
  if (n <= 64) return '17-64';
  if (n <= 256) return '65-256';
  if (n <= 1024) return '257-1024';
  return '>1024';
}
function resolveTs7Dir() {
  if (process.env.JSII_TS7_TYPESCRIPT) return process.env.JSII_TS7_TYPESCRIPT;
  const base = process.env.JSII_PERF_COMPILER_DIR ?? process.cwd();
  return path.dirname(require.resolve('typescript7/package.json', { paths: [base] }));
}
globalThis.__legePerfReady = (async () => {
  const cli = await import(pathToFileURL(path.join(resolveTs7Dir(), 'dist/api/async/client.js')).href);
  const P = cli.Client.prototype;
  const origDoBatch = P.doBatch;
  P.doBatch = async function () {
    const n = this.batchedRequests.length;
    if (n === 0) return origDoBatch.call(this);
    const p = ph();
    p.batches++;
    p.requests += n;
    if (n === 1) p.singles++;
    const b = bucket(n);
    p.hist.set(b, (p.hist.get(b) ?? 0) + 1);
    const t = nowMs();
    try {
      return await origDoBatch.call(this);
    } finally {
      p.rttMs += nowMs() - t;
    }
  };
})();
process.on('exit', () => {
  const out = { wallMs: nowMs(), marks, phases: {} };
  const lines = [`[lege-async] wall=${out.wallMs.toFixed(0)}ms marks: ${marks.map((m) => `${m.name}@${m.ms.toFixed(0)}`).join(' | ')}`];
  for (const [name, p] of phases) {
    out.phases[name] = { ...p, hist: Object.fromEntries(p.hist) };
    const hist = ['1', '2-4', '5-16', '17-64', '65-256', '257-1024', '>1024'].map((k) => `${k}:${p.hist.get(k) ?? 0}`).join(' ');
    lines.push(
      `[lege-async] phase=${name.padEnd(15)} batches=${String(p.batches).padStart(6)} requests=${String(p.requests).padStart(7)} avg/batch=${(p.requests / p.batches).toFixed(1).padStart(6)} singles=${String(p.singles).padStart(6)} sumRtt=${(p.rttMs / 1000).toFixed(1)}s  hist[${hist}]`,
    );
  }
  process.stderr.write(lines.join('\n') + '\n');
  if (process.env.JSII_PERF_OUT) fs.writeFileSync(process.env.JSII_PERF_OUT, JSON.stringify(out, null, 2));
});

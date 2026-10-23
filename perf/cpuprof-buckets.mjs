// Summarize a V8 .cpuprofile by self-time buckets relevant to the ts7 backend.
// usage: node cpuprof-buckets.mjs <file.cpuprofile> [topN]
import fs from 'node:fs';

const [file, topArg] = process.argv.slice(2);
const topN = Number(topArg ?? 40);
const prof = JSON.parse(fs.readFileSync(file, 'utf8'));
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const selfUs = new Map();
for (let i = 0; i < prof.samples.length; i++) {
  const id = prof.samples[i];
  selfUs.set(id, (selfUs.get(id) ?? 0) + (prof.timeDeltas[i] ?? 0));
}
const totalUs = [...selfUs.values()].reduce((a, b) => a + b, 0);

function bucketOf(cf) {
  const fn = cf.functionName;
  const url = cf.url ?? '';
  if (fn === '(garbage collector)') return 'gc';
  if (fn === '(program)' || fn === '(idle)' || fn === '(root)') return 'v8-' + fn;
  if (fn === 'readSync' || fn === 'read') return 'wait:readSync (server+pipe)';
  if (fn === 'writeSync' || fn === 'writeString' || fn === 'writeBuffer') return 'io:writeSync';
  if (fn === 'utf8Slice' || fn === 'toString' || fn === 'utf8Write' || fn === 'byteLength' || fn === 'byteLengthUtf8')
    return 'client:utf8 encode/decode';
  if (fn === 'parse' && url === '') return 'client:JSON.parse';
  if (fn === 'stringify' && url === '') return 'client:JSON.stringify';
  if (url.includes('/dist/api/syncChannel')) return 'client:syncChannel (framing/msgpack)';
  if (url.includes('/dist/api/node/')) return 'client:node.js (AST decode/RemoteNode)';
  if (url.includes('/dist/api/sync/api')) return 'client:sync/api.js (handles/materialize)';
  if (url.includes('/dist/api/sync/client')) return 'client:client.js';
  if (url.includes('/dist/api/')) return 'client:other dist/api';
  if (url.includes('/lib/ts7/assembler')) return 'jsii:ts7/assembler.ts';
  if (url.includes('/lib/ts7/')) return 'jsii:ts7 other';
  if (url.includes('/node_modules/typescript/')) return 'jsii:classic typescript (diag formatting etc.)';
  if (url.includes('/jsii-compiler/lib/')) return 'jsii:other lib';
  if (url.includes('node_modules/@jsii/spec')) return 'jsii:@jsii/spec (writeAssembly)';
  if (url.startsWith('node:') || url === '') return 'node-internal/native:' + (fn || '(anon)');
  return 'other:' + url.split('/node_modules/').pop().split('/')[0];
}

const buckets = new Map();
const funcs = new Map();
for (const [id, us] of selfUs) {
  const cf = byId.get(id).callFrame;
  const b = bucketOf(cf);
  buckets.set(b, (buckets.get(b) ?? 0) + us);
  const key = `${cf.functionName || '(anon)'}  ${cf.url.replace(/.*\/node_modules\//, '').replace(/.*jsii-compiler\//, '')}:${cf.lineNumber}`;
  funcs.set(key, (funcs.get(key) ?? 0) + us);
}
const fmt = (us) => `${(us / 1e6).toFixed(2).padStart(7)}s ${((100 * us) / totalUs).toFixed(1).padStart(5)}%`;
console.log(`total sampled: ${(totalUs / 1e6).toFixed(2)}s  (${file})\n== buckets (self time) ==`);
for (const [b, us] of [...buckets].sort((a, b) => b[1] - a[1])) console.log(`${fmt(us)}  ${b}`);
console.log(`\n== top ${topN} functions (self time) ==`);
for (const [k, us] of [...funcs].sort((a, b) => b[1] - a[1]).slice(0, topN)) console.log(`${fmt(us)}  ${k}`);

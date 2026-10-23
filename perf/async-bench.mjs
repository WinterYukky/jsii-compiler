// Pipelining microbenchmark: does the TypeScript 7 async API (`typescript/async`,
// which coalesces same-tick requests into one `batchRequests` and runs one goroutine
// per message on the server) deliver more checker queries per second than the sync
// API's one-at-a-time round trips? Same project, same query mix.
// usage: node async-bench.mjs <typescript7-package-dir> <project-root> [width]
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [ts7Dir, root, widthArg] = process.argv.slice(2);
const width = Number(widthArg ?? 64);
const tsconfig = path.join(root, 'tsconfig.json');
const u = (p) => pathToFileURL(path.join(ts7Dir, p)).href;
const now = () => Number(process.hrtime.bigint()) / 1e6;

// ---- collect a work list with the sync API (exported symbols of the first N modules)
const sync = await import(u('dist/api/sync/api.js'));
const sapi = new sync.API({ cwd: root, collectTiming: true });
const ssnap = sapi.createSnapshot({ openProjects: [tsconfig] });
const sproj = ssnap.getConfiguredProject(tsconfig);
const files = sproj.program.getSourceFileNames().filter((f) => !f.includes('node_modules') && f.endsWith('.ts') && !f.endsWith('.d.ts'));
const pick = files.filter((_, i) => i % 7 === 0).slice(0, 220);
const syms = [];
for (const fileName of pick) {
  const sf = sproj.program.getSourceFile(fileName);
  const ms = sf && sproj.checker.getSymbolAtLocation(sf);
  if (!ms) continue;
  for (const s of sproj.checker.getExportsOfModule(ms)) syms.push(s);
}
console.log(`work list: ${syms.length} exported symbols from ${pick.length} files`);

function perSymbolSync(checker, s) {
  const t = checker.getTypeOfSymbol(s);
  checker.getFullyQualifiedName(s);
  s.getJsDocTags(checker);
  s.getDocumentationComment(checker);
  if (t) checker.getPropertiesOfType(t).length;
}
sapi.getTimingInfo(); // warm
let t0 = now();
let before = sapi.getTimingInfo().totals.requestCount;
for (const s of syms) perSymbolSync(sproj.checker, s);
const syncMs = now() - t0;
const syncReq = sapi.getTimingInfo().totals.requestCount - before;
console.log(`sync   : ${syncMs.toFixed(0)} ms, ${syncReq} requests, ${(syncMs * 1000 / syncReq).toFixed(1)} us/req, ${(syms.length / (syncMs / 1000)).toFixed(0)} symbols/s`);
ssnap.dispose();
sapi.close();

// ---- same work on the async API: fresh server process per configuration (no warm checker)
const asyncMod = await import(u('dist/api/async/api.js'));
async function run(label, w) {
  const aapi = new asyncMod.API({ cwd: root, collectTiming: true });
  const asnap = await aapi.createSnapshot({ openProjects: [tsconfig] });
  const aproj = asnap.getConfiguredProject(tsconfig);
  const asyms = [];
  for (const sf of pick) {
    const asf = await aproj.program.getSourceFile(sf);
    const ms = asf && (await aproj.checker.getSymbolAtLocation(asf));
    if (!ms) continue;
    for (const s of await aproj.checker.getExportsOfModule(ms)) asyms.push(s);
  }
  async function perSymbolAsync(checker, s) {
    const t = await checker.getTypeOfSymbol(s);
    await checker.getFullyQualifiedName(s);
    await s.getJsDocTags(checker);
    await s.getDocumentationComment(checker);
    if (t) (await checker.getPropertiesOfType(t)).length;
  }
  const b = (await aapi.getTimingInfo()).totals.requestCount;
  const t = now();
  for (let i = 0; i < asyms.length; i += w) {
    await Promise.all(asyms.slice(i, i + w).map((s) => perSymbolAsync(aproj.checker, s)));
  }
  const ms = now() - t;
  const ti = await aapi.getTimingInfo();
  const req = ti.totals.requestCount - b;
  console.log(`${label.padEnd(9)}: ${ms.toFixed(0)} ms, ${req} wire requests, ${(asyms.length / (ms / 1000)).toFixed(0)} symbols/s, recv ${(ti.totals.bytesReceived / 1e6).toFixed(1)} MB`);
  await asnap.dispose();
  await aapi.close();
}
await run('async1024', 1024);
await run('async256', 256);
await run('async64', 64);
await run('async16', 16);
await run('async1', 1);

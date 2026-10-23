// Payload-size microbenchmark for the TypeScript 7 sync RPC channel.
// usage: node echo-bench.mjs <typescript7-package-dir> <project-cwd>
// Measures the fixed per-request cost vs. the per-byte cost with the server's `echo`
// method (pure transport: no checker work, Go returns the payload unchanged), then
// a real checker method (getPropertiesOfType on types of increasing size).
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const [ts7Dir, cwd] = process.argv.slice(2);
const { API } = await import(pathToFileURL(path.join(ts7Dir, 'dist/api/sync/api.js')).href);
const api = new API({ cwd });
const client = api.client;
const chan = client.channel;

function bench(label, fn, iters) {
  for (let i = 0; i < Math.min(50, iters); i++) fn(); // warm-up
  const t = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const us = Number(process.hrtime.bigint() - t) / 1e3 / iters;
  console.log(`${label.padEnd(44)} ${us.toFixed(1).padStart(10)} us/req`);
  return us;
}

console.log('--- echo (string payload, Node sends N bytes, Go echoes N bytes back) ---');
const sizes = [0, 100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000];
const results = [];
for (const n of sizes) {
  const payload = 'x'.repeat(n);
  const iters = n >= 1_000_000 ? 20 : n >= 100_000 ? 200 : 2000;
  const us = bench(`echo ${n}B`, () => chan.requestSync('echo', payload), iters);
  results.push([n, us]);
}
console.log('--- echo binary (requestBinarySync: no utf8 decode on the way back) ---');
for (const n of [0, 1_000, 100_000, 1_000_000, 10_000_000]) {
  const payload = Buffer.alloc(n, 0x78);
  const iters = n >= 1_000_000 ? 20 : n >= 100_000 ? 200 : 2000;
  bench(`echoBinary ${n}B`, () => chan.requestBinarySync('echo', payload), iters);
}
// linear fit on echo: us = a + b * bytes  (fixed cost a; per-MB cost b*1e6)
const xs = results.map(([n]) => n);
const ys = results.map(([, us]) => us);
const mx = xs.reduce((a, b) => a + b) / xs.length;
const my = ys.reduce((a, b) => a + b) / ys.length;
const b = xs.reduce((acc, x, i) => acc + (x - mx) * (ys[i] - my), 0) / xs.reduce((acc, x) => acc + (x - mx) ** 2, 0);
const a = my - b * mx;
console.log(`fit: fixed ≈ ${a.toFixed(1)} us/req, incremental ≈ ${(b * 1e6 / 1e3).toFixed(2)} ms per MB (round trip, both directions)`);

console.log('--- JSON.parse cost reference (Node only) ---');
for (const n of [100, 1_000, 10_000, 100_000, 1_000_000]) {
  const obj = { items: Array.from({ length: Math.max(1, n / 50) }, (_, i) => ({ id: i, name: 'prop' + i, flags: 4 })) };
  const s = JSON.stringify(obj);
  const iters = n >= 1_000_000 ? 20 : 2000;
  bench(`JSON.parse ${s.length}B`, () => JSON.parse(s), iters);
}
api.close();

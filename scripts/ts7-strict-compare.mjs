#!/usr/bin/env node
// Strict field-by-field comparison of two .jsii assemblies (plain or .gz).
// Usage: node scripts/ts7-strict-compare.mjs <a.jsii[.gz]> <b.jsii[.gz]> [--exclude field,field,...]
// Default exclusions: jsiiVersion, fingerprint, metadata.tscOutDir (differ between any two builds/compilers).
// Pass --exclude to override, e.g. --exclude jsiiVersion,fingerprint,locationInModule,metadata.tscOutDir
import * as fs from 'node:fs';
import * as zlib from 'node:zlib';

const args = process.argv.slice(2);
const exIdx = args.indexOf('--exclude');
const files = args.filter((a, i) => !a.startsWith('--') && i !== exIdx + 1);
const excluded = new Set(
  (exIdx >= 0 ? args[exIdx + 1] : 'jsiiVersion,fingerprint,metadata.tscOutDir').split(',').filter(Boolean),
);

function load(file) {
  let buf = fs.readFileSync(file);
  if (file.endsWith('.gz') || (buf[0] === 0x1f && buf[1] === 0x8b)) {
    buf = zlib.gunzipSync(buf);
  }
  const json = JSON.parse(buf.toString('utf8'));
  // `.jsii` may be a redirect to the compressed file
  if (json.schema === 'jsii/file-redirect') {
    return load(file.replace(/[^/]*$/, json.filename));
  }
  return json;
}

const [a, b] = files.map(load);
const diffs = [];
const keyed = new Set(['properties', 'methods', 'members', 'parameters']);

function pathKey(path, k, parent) {
  if (Array.isArray(parent) && keyed.has(path[path.length - 1]) && parent[k]?.name != null) {
    return `${path.slice(0, -1).join('.')}.${path[path.length - 1]}[${parent[k].name}]`;
  }
  return [...path, k].join('.');
}

function excludedPath(path) {
  const joined = path.join('.');
  for (const ex of excluded) {
    if (joined === ex || joined.endsWith(`.${ex}`) || path.includes(ex)) return true;
  }
  return false;
}

function cmp(x, y, path) {
  if (excludedPath(path)) return;
  if (typeof x !== typeof y || (x === null) !== (y === null) || Array.isArray(x) !== Array.isArray(y)) {
    diffs.push({ path: path.join('.'), a: x, b: y });
    return;
  }
  if (x !== null && typeof x === 'object') {
    if (Array.isArray(x)) {
      const byName = x.every((e) => e?.name != null) && y.every((e) => e?.name != null);
      if (byName) {
        const xm = new Map(x.map((e) => [e.name, e]));
        const ym = new Map(y.map((e) => [e.name, e]));
        for (const n of new Set([...xm.keys(), ...ym.keys()])) {
          cmp(xm.get(n), ym.get(n), [...path.slice(0, -1), `${path[path.length - 1]}[${n}]`]);
        }
        const xo = x.map((e) => e.name).join(',');
        const yo = y.map((e) => e.name).join(',');
        if (xo !== yo) diffs.push({ path: `${path.join('.')} (order)`, a: xo, b: yo });
        return;
      }
      const n = Math.max(x.length, y.length);
      for (let i = 0; i < n; i++) cmp(x[i], y[i], [...path, String(i)]);
      return;
    }
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) cmp(x[k], y[k], [...path, k]);
    return;
  }
  if (x !== y) diffs.push({ path: path.join('.'), a: x, b: y });
}

cmp(a, b, []);
const typesA = Object.keys(a.types ?? {}).length;
const typesB = Object.keys(b.types ?? {}).length;
console.log(`types: ${typesA} vs ${typesB}; excluded: ${[...excluded].join(', ')}; differing leaf fields: ${diffs.length}`);
for (const d of diffs.slice(0, 200)) {
  console.log(`  ${d.path}\n    a: ${JSON.stringify(d.a)?.slice(0, 200)}\n    b: ${JSON.stringify(d.b)?.slice(0, 200)}`);
}
if (diffs.length > 200) console.log(`  ... ${diffs.length - 200} more`);
process.exit(diffs.length === 0 ? 0 : 1);

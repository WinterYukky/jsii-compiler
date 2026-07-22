// compare-jsii: structural diff between a reference .jsii and an assembler-lite assembly.
// Usage: node compare-jsii.mjs <reference.jsii> <generated.json>
import * as fs from 'node:fs';

const ref = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const gen = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));

const report = { matchedTypes: 0, missingTypes: [], extraTypes: [], memberDiffs: [], fieldDiffs: [] };

const refTypes = ref.types ?? {};
const genTypes = gen.types ?? {};

for (const fqn of Object.keys(refTypes)) if (!genTypes[fqn]) report.missingTypes.push(fqn);
for (const fqn of Object.keys(genTypes)) if (!refTypes[fqn]) report.extraTypes.push(fqn);

function canon(x) {
  if (Array.isArray(x)) return x.map(canon);
  if (x && typeof x === 'object' && x.union && Array.isArray(x.union.types)) {
    // union member order is semantically insignificant; normalize for comparison
    const types = x.union.types.map(canon).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { ...Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'union').map(([k, v]) => [k, canon(v)])), union: { types } };
  }
  if (x && typeof x === 'object') {
    const o = {};
    for (const k of Object.keys(x).sort()) o[k] = canon(x[k]);
    return o;
  }
  return x;
}

function normMember(m) {
  const c = JSON.parse(JSON.stringify(m));
  delete c.locationInModule;
  delete c.overrides;
  if (c.docs) {
    // compare only presence of summary and key tags
    c.docs = Object.fromEntries(Object.entries(c.docs).filter(([k]) => ['default', 'deprecated', 'stability'].includes(k)));
    if (!Object.keys(c.docs).length) delete c.docs;
  }
  return c;
}

function diffMembers(fqn, kind, refList = [], genList = []) {
  const refMap = new Map(refList.map((m) => [m.name, m]));
  const genMap = new Map(genList.map((m) => [m.name, m]));
  for (const [name, rm] of refMap) {
    const gm = genMap.get(name);
    if (!gm) { report.memberDiffs.push(`${fqn} ${kind} ${name}: MISSING in generated`); continue; }
    const a = JSON.stringify(canon(normMember(rm)));
    const b = JSON.stringify(canon(normMember(gm)));
    if (a !== b) report.memberDiffs.push(`${fqn} ${kind} ${name}: DIFFER\n  ref: ${a}\n  gen: ${b}`);
  }
  for (const name of genMap.keys()) {
    if (!refMap.has(name)) report.memberDiffs.push(`${fqn} ${kind} ${name}: EXTRA in generated`);
  }
}

for (const [fqn, rt] of Object.entries(refTypes)) {
  const gt = genTypes[fqn];
  if (!gt) continue;
  report.matchedTypes++;
  for (const field of ['kind', 'base', 'abstract', 'datatype', 'symbolId']) {
    const a = JSON.stringify(rt[field]);
    const b = JSON.stringify(gt[field]);
    if (a !== b) report.fieldDiffs.push(`${fqn}.${field}: ref=${a} gen=${b}`);
  }
  const ri = JSON.stringify((rt.interfaces ?? []).slice().sort());
  const gi = JSON.stringify((gt.interfaces ?? []).slice().sort());
  if (ri !== gi) report.fieldDiffs.push(`${fqn}.interfaces: ref=${ri} gen=${gi}`);
  diffMembers(fqn, 'prop', rt.properties, gt.properties);
  diffMembers(fqn, 'method', rt.methods, gt.methods);
  if (rt.kind === 'enum') {
    const rm = JSON.stringify((rt.members ?? []).map((m) => m.name).sort());
    const gm = JSON.stringify((gt.members ?? []).map((m) => m.name).sort());
    if (rm !== gm) report.fieldDiffs.push(`${fqn}.members: ref=${rm} gen=${gm}`);
  }
  if (rt.initializer || gt.initializer) {
    diffMembers(fqn, 'initializer', rt.initializer ? [{ ...rt.initializer, name: '<init>' }] : [], gt.initializer ? [{ ...gt.initializer, name: '<init>' }] : []);
  }
}

console.log(`=== compare summary ===`);
console.log(`types: ref=${Object.keys(refTypes).length} gen=${Object.keys(genTypes).length} matched=${report.matchedTypes}`);
console.log(`missing: ${report.missingTypes.length} ${JSON.stringify(report.missingTypes)}`);
console.log(`extra:   ${report.extraTypes.length} ${JSON.stringify(report.extraTypes)}`);
console.log(`field diffs: ${report.fieldDiffs.length}`);
for (const d of report.fieldDiffs) console.log(`  - ${d}`);
console.log(`member diffs: ${report.memberDiffs.length}`);
for (const d of report.memberDiffs) console.log(`  - ${d}`);

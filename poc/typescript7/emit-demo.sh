#!/bin/bash
# Emit demo: tsgo emit + Node post-processing injects jsii rtti; verify against real jsii output.
set -e
export HOME=/root
cd /work-constructs
# 1) tsgo emit to /tmp/emit-tsgo (same tsconfig)
rm -rf /tmp/emit-tsgo /tmp/demo.tsbuildinfo
/work-ts/built/local/tsgo -p tsconfig.json --outDir /tmp/emit-tsgo --declaration --types node --tsBuildInfoFile /tmp/demo.tsbuildinfo >/dev/null 2>&1 || true
ls /tmp/emit-tsgo/*.js >/dev/null

# 2) post-process: inject rtti from the assembler-lite assembly
node - <<'NODE'
const fs = require('fs'), path = require('path');
const asm = JSON.parse(fs.readFileSync('/tmp/g3', 'utf8'));
const byFile = {};
for (const [fqn, t] of Object.entries(asm.types)) {
  if (t.kind !== 'class') continue;
  const js = t.locationInModule.filename.replace(/^(lib|src)\//, '').replace(/\.ts$/, '.js');
  (byFile[js] ??= []).push({ name: t.name, fqn });
}
for (const [js, classes] of Object.entries(byFile)) {
  const p = path.join('/tmp/emit-tsgo', js);
  if (!fs.existsSync(p)) { console.error('skip missing', p); continue; }
  let code = fs.readFileSync(p, 'utf8');
  code += '\n// jsii runtime type information (injected post-emit)\n';
  for (const c of classes) {
    code += `try { Object.defineProperty(exports.${c.name}, Symbol.for("jsii.rtti"), { value: { fqn: "${c.fqn}", version: "${asm.version}" }, configurable: true }); } catch (e) { }\n`;
  }
  fs.writeFileSync(p, code);
}
console.log('rtti injected into', Object.keys(byFile).length, 'files');
NODE

# 3) verify: compare rtti between real jsii output (/work-constructs/lib) and tsgo+postprocess (/tmp/emit-tsgo)
node - <<'NODE'
const real = require('/work-constructs/lib/index.js');
const mine = require('/tmp/emit-tsgo/index.js');
const RTTI = Symbol.for('jsii.rtti');
let ok = 0, bad = 0;
for (const name of Object.keys(real)) {
  const r = real[name], m = mine[name];
  if (typeof r !== 'function') continue;
  const rr = r[RTTI], mm = m && m[RTTI];
  if (JSON.stringify(rr) === JSON.stringify(mm)) ok++;
  else { bad++; console.log('MISMATCH', name, JSON.stringify(rr), JSON.stringify(mm)); }
}
console.log(`rtti identical for ${ok} classes, mismatches: ${bad}`);
NODE
echo EMIT_DEMO_DONE

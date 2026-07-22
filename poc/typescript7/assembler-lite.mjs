// assembler-lite: a minimal jsii Assembler reimplemented on the TypeScript 7 API.
// Produces a .jsii-like assembly JSON for a package and prints timing to stderr.
//
// Usage: node assembler-lite.mjs <packageRoot> [entry] > assembly.json
// Env:   TSGO_PATH — path to the (patched) tsgo binary
//        NP_LIB    — path to the built native-preview package dir
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const NP = process.env.NP_LIB ?? '/work-ts/_packages/native-preview';
const { API, SymbolFlags, TypeFlags } = await import(path.join(NP, 'dist/api/sync/api.js'));
const { SyntaxKind } = await import(path.join(NP, 'dist/ast/index.js'));

const root = path.resolve(process.argv[2] ?? '.');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const assemblyName = pkg.name;
const entry = path.resolve(root, process.argv[3] ?? (pkg.types ?? 'src/index.ts').replace(/\.d\.ts$/, '.ts').replace(/^lib\//, 'src/'));

const t0 = performance.now();
const api = new API({ cwd: root, tsserverPath: process.env.TSGO_PATH ?? '/work-ts/built/local/tsgo' });
const snapshot = api.updateSnapshot({ openProjects: [path.join(root, 'tsconfig.json')] });
const project = snapshot.getProject(path.join(root, 'tsconfig.json'));
if (!project) throw new Error('project not found');
const { program, checker } = project;
const t1 = performance.now();

const entrySf = program.getSourceFile(entry);
if (!entrySf) throw new Error(`entrypoint not found: ${entry}`);
const moduleSymbol = checker.getSymbolAtLocation(entrySf);
const moduleExports = checker.getExportsOfModule(moduleSymbol);

const types = {};
const typeFqnBySymbolId = new Map();
const submodules = {};

function resolveAlias(sym) {
  let s = sym;
  while ((s.flags & SymbolFlags.Alias) !== 0) s = checker.getAliasedSymbol(s);
  return s;
}

// external dependency assemblies (e.g. constructs): name -> Set(exported type names)
const externalDeps = new Map();
for (const dep of Object.keys(pkg.peerDependencies ?? {})) {
  try {
    const req = createRequire(path.join(root, 'package.json'));
    const depDir = path.dirname(req.resolve(`${dep}/package.json`));
    let raw = fs.readFileSync(path.join(depDir, '.jsii'), 'utf8');
    let depJsii = JSON.parse(raw);
    if (depJsii.schema === 'jsii/file-redirect') {
      const zlib = await import('node:zlib');
      depJsii = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(depDir, depJsii.filename))).toString('utf8'));
    }
    externalDeps.set(dep, new Set(Object.keys(depJsii.types ?? {}).map((f) => f.slice(depJsii.name.length + 1))));
  } catch { /* not a jsii dep */ }
}
const bundled = new Set(pkg.bundledDependencies ?? pkg.bundleDependencies ?? []);
const stripDeprecated = !!(pkg['cdk-build']?.stripDeprecated);
let stripAllowList; // undefined = strip all deprecated; Set = strip only listed FQNs
if (process.env.STRIP_ALLOWLIST && fs.existsSync(process.env.STRIP_ALLOWLIST)) {
  stripAllowList = new Set(fs.readFileSync(process.env.STRIP_ALLOWLIST, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean));
}

function isDeprecated(sym) {
  return sym.getJsDocTags(checker).some((t) => t.name === 'deprecated');
}
function shouldStrip(sym, fqn) {
  if (!stripDeprecated || !isDeprecated(sym)) return false;
  if (!stripAllowList) return true;
  return stripAllowList.has(fqn);
}

function externalFqnOf(sym) {
  const decl0 = sym.declarations?.[0];
  if (!decl0) return undefined;
  const file = decl0.path ?? '';
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(file);
  if (!m) return undefined;
  const dep = m[1];
  if (!externalDeps.has(dep)) return undefined;
  if (externalDeps.get(dep).has(sym.name)) return `${dep}.${sym.name}`;
  return undefined;
}

const exported = [];
const candidates = new Map(); // symId -> [{name, prefix, moduleDir, sym}]
const visitedModules = new Set();
function collectModuleExports(mExports, prefix, moduleDir) {
  for (const e of mExports) {
    const sym = resolveAlias(e);
    const declH = sym.declarations?.[0];
    if (!declH) continue;
    const kind = declH.kind;
    if ([SyntaxKind.ClassDeclaration, SyntaxKind.InterfaceDeclaration, SyntaxKind.EnumDeclaration].includes(kind)) {
      const nm = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(declH.path ?? '');
      if (nm && externalDeps.has(nm[1])) continue; // peer-dependency type: referenced externally, not owned
      if (!candidates.has(sym.id)) candidates.set(sym.id, []);
      candidates.get(sym.id).push({ name: e.name, prefix, moduleDir, sym });
    } else if (kind === SyntaxKind.SourceFile || (sym.flags & SymbolFlags.ValueModule) !== 0 || (sym.flags & SymbolFlags.NamespaceModule) !== 0) {
      const subFqn = `${prefix}.${e.name}`;
      const key = `${sym.id}:${subFqn}`;
      if (visitedModules.has(key)) continue;
      visitedModules.add(key);
      if (prefix === assemblyName) submodules[subFqn] = {};
      const subDir = path.dirname(sym.declarations?.[0]?.path ?? moduleDir);
      collectModuleExports(checker.getExportsOfModule(sym), subFqn, subDir);
    }
  }
}
collectModuleExports(moduleExports, assemblyName, path.dirname(entry));

function registerType(sym, name, fqn) {
  if (typeFqnBySymbolId.has(sym.id)) return;
  if (isInternal(sym) || shouldStrip(sym, fqn)) return;
  const decl = sym.declarations?.[0]?.resolve(project);
  if (!decl) return;
  typeFqnBySymbolId.set(sym.id, fqn);
  exported.push({ name, sym, decl, fqn });
  const nested = sym.getExports?.();
  if (nested && nested.size) {
    for (const [, nsym0] of nested) {
      const nsym = resolveAlias(nsym0);
      const nDeclH = nsym.declarations?.[0];
      if (!nDeclH) continue;
      if ([SyntaxKind.ClassDeclaration, SyntaxKind.InterfaceDeclaration, SyntaxKind.EnumDeclaration].includes(nDeclH.kind)) {
        registerType(nsym, nsym.name, `${fqn}.${nsym.name}`);
      }
    }
  }
}
for (const [, cands] of candidates) {
  let best = cands[0];
  let bestLen = -1;
  for (const c of cands) {
    const declPath = c.sym.declarations?.[0]?.path ?? '';
    const dir = c.moduleDir.endsWith('/') ? c.moduleDir : c.moduleDir + '/';
    const len = declPath.startsWith(dir) ? dir.length : -1;
    if (len > bestLen) { bestLen = len; best = c; }
  }
  registerType(best.sym, best.name, `${best.prefix}.${best.name}`);
}

const defaultStability = pkg.stability;
let currentStability = defaultStability;
function docsOf(sym) {
  const summaryRaw = sym.getDocumentationComment(checker);
  const docs = {};
  if (summaryRaw) {
    const text = summaryRaw.trim();
    let splitAt = -1;
    let paren = 0; let tick = false;
    for (let i = 0; i < text.length - 1; i++) {
      const ch = text[i];
      if (ch === '`') tick = !tick;
      else if (!tick && (ch === '(' || ch === '[')) paren++;
      else if (!tick && (ch === ')' || ch === ']')) paren = Math.max(0, paren - 1);
      else if (ch === '.' && !tick && paren === 0 && /\s/.test(text[i + 1])) {
        const before = text.slice(Math.max(0, i - 3), i).toLowerCase();
        if (before.endsWith('e.g') || before.endsWith('i.e') || before.endsWith('etc')) continue;
        splitAt = i; break;
      }
    }
    const summary = splitAt >= 0 ? text.slice(0, splitAt + 1) : text;
    const rest = splitAt >= 0 ? text.slice(splitAt + 1).trim() : '';
    if (rest) docs.remarks = rest;
    docs.summary = summary.replace(/\s+/g, ' ').trim().replace(/(?<![.!?])$/, '.');
  }
  for (const tag of sym.getJsDocTags(checker)) {
    const text = typeof tag.text === 'string' ? tag.text : (tag.text ?? []).map((p) => p.text).join('');
    if (tag.name === 'default') docs.default = text.trim();
    else if (tag.name === 'deprecated') { docs.deprecated = text.trim(); docs.stability = 'deprecated'; }
    else if (tag.name === 'stability') docs.stability = text.trim();
    else if (tag.name === 'example') docs.example = text.replace(/^\n/, '');
    else if (tag.name === 'returns') docs.returns = text.trim();
    else if (tag.name === 'see') docs.see = text.trim();
  }
  return Object.keys(docs).length ? docs : undefined;
}

function symbolIdOf(sym) {
  const tsFqn = checker.getFullyQualifiedName(sym); // e.g. "/abs/path/src/construct".Construct
  const m = /^"([^"]+)"(?:\.(.*))?$/.exec(tsFqn);
  if (!m) return undefined;
  let rel;
  const nm = m[1].lastIndexOf('node_modules/');
  if (nm >= 0) {
    const after = m[1].slice(nm + 'node_modules/'.length);
    rel = after.split('/').slice(after.startsWith('@') ? 2 : 1).join('/');
  } else {
    rel = path.relative(root, m[1]);
  }
  return `${rel}:${m[2] ?? ''}`;
}

function isInternal(sym) {
  return sym.getJsDocTags(checker).some((t) => t.name === 'internal') || sym.name.startsWith('_');
}

function unionNodeOf(typeNode) {
  if (!typeNode) return undefined;
  if (typeNode.kind === SyntaxKind.UnionType) return typeNode;
  if (typeNode.kind === SyntaxKind.TypeReference) {
    const s0 = checker.getSymbolAtLocation(typeNode.typeName);
    const s = s0 ? resolveAlias(s0) : undefined;
    const d = s?.declarations?.[0]?.resolve(project);
    if (d?.kind === SyntaxKind.TypeAliasDeclaration && d.type?.kind === SyntaxKind.UnionType) return d.type;
  }
  return undefined;
}

function typeRefOf(type, optionalOut, typeNode) {
  if (!type) return { primitive: 'any' };
  const f = type.flags;
  if (f & TypeFlags.EnumLike) {
    const s = type.getSymbol();
    const parent = s?.getParent();
    const fqn = s && (typeFqnBySymbolId.get(s.id) ?? externalFqnOf(s)
      ?? (parent && (typeFqnBySymbolId.get(parent.id) ?? externalFqnOf(parent))));
    if (fqn) return { fqn };
  }
  if (f & TypeFlags.NonPrimitive) return { primitive: 'json' };
  if (f & TypeFlags.StringLike) return { primitive: 'string' };
  if (f & TypeFlags.NumberLike) return { primitive: 'number' };
  if (f & TypeFlags.BooleanLike) return { primitive: 'boolean' };
  if (f & (TypeFlags.Any | TypeFlags.Unknown)) return { primitive: 'any' };
  if (f & TypeFlags.Void) return undefined;
  if (type.isUnionType()) {
    const all = type.getTypes();
    const parts = all.filter((t) => !(t.flags & (TypeFlags.Undefined | TypeFlags.Null)));
    if (optionalOut && parts.length !== all.length) optionalOut.optional = true;
    const un = unionNodeOf(typeNode);
    if (un) {
      const refs = [];
      const seen = new Set();
      const pushFlat = (r) => {
        if (!r) return;
        if (r.union) { r.union.types.forEach(pushFlat); return; }
        const key = JSON.stringify(r);
        if (!seen.has(key)) { seen.add(key); refs.push(r); }
      };
      for (const tn of un.types) {
        const tt = checker.getTypeFromTypeNode(tn);
        if (tt && (tt.flags & (TypeFlags.Undefined | TypeFlags.Null))) { if (optionalOut) optionalOut.optional = true; continue; }
        pushFlat(typeRefOf(tt, optionalOut, tn));
      }
      if (refs.length === 1) return refs[0];
      if (refs.length > 1) return { union: { types: refs } };
    }
    const refs = [];
    const seen = new Set();
    for (const p of parts) {
      const r = typeRefOf(p, optionalOut);
      const key = JSON.stringify(r);
      if (r && !seen.has(key)) { seen.add(key); refs.push(r); }
    }
    if (refs.length === 1) return refs[0];
    return { union: { types: refs } };
  }
  if (checker.isArrayType(type)) {
    const args = type.isTypeReference() ? checker.getTypeArguments(type) : [];
    return { collection: { elementtype: typeRefOf(args[0]), kind: 'array' } };
  }
  const sym = type.getSymbol();
  if (sym) {
    const target = type.isTypeReference() ? type.getTarget() : type;
    const tsym = target.getSymbol() ?? sym;
    const fqn = typeFqnBySymbolId.get(tsym.id) ?? externalFqnOf(tsym);
    if (fqn) return { fqn };
  }
  const indexInfos = checker.getIndexInfosOfType(type);
  if (indexInfos.length) {
    return { collection: { elementtype: typeRefOf(indexInfos[0].valueType), kind: 'map' } };
  }
  return { primitive: 'any' };
}

function paramOf(prm) {
  const decl = prm.declarations?.[0]?.resolve(project);
  const t = decl ? checker.getTypeOfSymbolAtLocation(prm, decl) : undefined;
  const opt = {};
  const p = { name: prm.name, type: typeRefOf(t, opt, decl?.type) };
  if (decl?.dotDotDotToken) { p.variadic = true; p.type = p.type?.collection?.elementtype ?? p.type; }
  else if (decl?.questionToken != null || decl?.initializer != null || opt.optional) p.optional = true;
  const d = docsOf(prm);
  if (d) p.docs = d;
  return p;
}

function locOf(decl) {
  const sf = decl.getSourceFile();
  const { line } = sf.getLineAndCharacterOfPosition(decl.getStart(sf));
  return { filename: path.relative(root, sf.fileName), line: line + 1 };
}

function withDefaultDocs(obj) {
  if (!currentStability) return obj;
  if (!obj.docs) obj.docs = { stability: currentStability };
  else if (!obj.docs.stability) obj.docs.stability = currentStability;
  return obj;
}

function methodOf(msym, decl, isStatic) {
  const sig = checker.getSignatureFromDeclaration(decl);
  const m = { locationInModule: locOf(decl), name: msym.name };
  if (isStatic) m.static = true;
  const mods = decl.modifiers ?? [];
  if (mods.some((x) => x.kind === SyntaxKind.AbstractKeyword)) m.abstract = true;
  if (mods.some((x) => x.kind === SyntaxKind.ProtectedKeyword)) m.protected = true;
  if (sig) {
    const params = sig.getParameters().map(paramOf);
    if (params.length) m.parameters = params;
    if (params.some((p) => p.variadic)) m.variadic = true;
    const opt = {};
    const ret = typeRefOf(checker.getReturnTypeOfSignature(sig), opt, decl.type);
    if (ret) m.returns = opt.optional ? { optional: true, type: ret } : { type: ret };
  }
  const d = docsOf(msym);
  if (d) m.docs = d;
  return withDefaultDocs(m);
}

function propOf(psym, decl, isStatic) {
  const t = checker.getTypeOfSymbolAtLocation(psym, decl);
  const opt = {};
  const p = { locationInModule: locOf(decl), name: psym.name, type: typeRefOf(t, opt, decl.type) };
  const mods = decl.modifiers ?? [];
  const hasSetter = psym.declarations?.some((h) => h.kind === SyntaxKind.SetAccessor);
  if (mods.some((x) => x.kind === SyntaxKind.ReadonlyKeyword) || (decl.kind === SyntaxKind.GetAccessor && !hasSetter)) p.immutable = true;
  if (mods.some((x) => x.kind === SyntaxKind.ProtectedKeyword)) p.protected = true;
  if (mods.some((x) => x.kind === SyntaxKind.AbstractKeyword)) p.abstract = true;
  if (isStatic) { p.static = true; if (mods.some((x) => x.kind === SyntaxKind.ReadonlyKeyword)) p.const = true; }
  const q = decl.questionToken ?? (decl.postfixToken?.kind === SyntaxKind.QuestionToken ? decl.postfixToken : undefined);
  if (q != null || opt.optional) p.optional = true;
  const d = docsOf(psym);
  if (d) p.docs = d;
  return withDefaultDocs(p);
}

function membersOfClassLike(sym, decl, jsiiType, isInterface) {
  const type = checker.getTypeAtLocation(decl);
  const props = [];
  const methods = [];
  for (const p of checker.getPropertiesOfType(type)) {
    if (isInternal(p)) continue;
    if (shouldStrip(p, `${jsiiType.fqn}#${p.name}`)) continue;
    const pDecl = p.declarations?.[0]?.resolve(project);
    if (!pDecl) continue;
    if ((pDecl.modifiers ?? []).some((x) => x.kind === SyntaxKind.PrivateKeyword)) continue;
    if (pDecl.parent !== decl) {
      if (!isInterface) continue; // own members only for classes
      const parentType = checker.getTypeAtLocation(pDecl.parent);
      const psym2 = parentType.getSymbol();
      const pfqn = psym2 && (typeFqnBySymbolId.get(psym2.id) ?? externalFqnOf(psym2));
      if (pfqn) continue; // exported base: members come via `interfaces`; unexported base: hoist (erased base)
    }
    if ((p.flags & SymbolFlags.Method) !== 0) {
      const m = methodOf(p, pDecl, false);
      if (isInterface) m.abstract = true;
      methods.push(m);
    } else {
      const pr = propOf(p, pDecl, false);
      if (isInterface) pr.abstract = true;
      props.push(pr);
    }
  }
  if (!isInterface) {
    const staticType = checker.getTypeOfSymbol(sym);
    for (const sp of (staticType ? checker.getPropertiesOfType(staticType) : [])) {
      if (sp.name === 'prototype' || isInternal(sp)) continue;
      if (shouldStrip(sp, `${jsiiType.fqn}#${sp.name}`)) continue;
      const spDecl = sp.declarations?.[0]?.resolve(project);
      if (!spDecl || spDecl.parent !== decl) continue;
      if ((spDecl.modifiers ?? []).some((x) => x.kind === SyntaxKind.PrivateKeyword)) continue;
      if ((sp.flags & SymbolFlags.Method) !== 0) methods.push(methodOf(sp, spDecl, true));
      else props.push(propOf(sp, spDecl, true));
    }
  }
  if (props.length) jsiiType.properties = props.sort((a, b) => a.name.localeCompare(b.name));
  if (methods.length) jsiiType.methods = methods.sort((a, b) => a.name.localeCompare(b.name));
}

for (const { name, sym, decl, fqn } of exported) {
  const jsiiType = { assembly: assemblyName, fqn, kind: '', locationInModule: locOf(decl), name };
  const d = docsOf(sym);
  if (d) jsiiType.docs = d;
  currentStability = d?.stability ?? defaultStability;
  withDefaultDocs(jsiiType);
  const symbolId = symbolIdOf(sym);
  if (symbolId) jsiiType.symbolId = symbolId;

  if (decl.kind === SyntaxKind.EnumDeclaration) {
    jsiiType.kind = 'enum';
    const members = [];
    for (const [, msym] of sym.getExports()) {
      if (msym.declarations?.[0]?.kind !== SyntaxKind.EnumMember) continue;
      if (isInternal(msym) || shouldStrip(msym, `${fqn}#${msym.name}`)) continue;
      const member = { name: msym.name };
      const md = docsOf(msym);
      if (md) member.docs = md;
      members.push(withDefaultDocs(member));
    }
    jsiiType.members = members;
  } else if (decl.kind === SyntaxKind.InterfaceDeclaration) {
    jsiiType.kind = 'interface';
    const type = checker.getTypeAtLocation(decl);
    const bases = (type.getBaseTypes() ?? [])
      .map((b) => { const s = b.getSymbol(); return s && (typeFqnBySymbolId.get(s.id) ?? externalFqnOf(s)); })
      .filter(Boolean);
    if (bases.length) jsiiType.interfaces = bases;
    membersOfClassLike(sym, decl, jsiiType, true);
    if (!jsiiType.methods && !/^I[A-Z]/.test(name) && (jsiiType.properties ?? []).every((p) => p.immutable)) {
      jsiiType.datatype = true;
    }
  } else {
    jsiiType.kind = 'class';
    const mods = decl.modifiers ?? [];
    if (mods.some((x) => x.kind === SyntaxKind.AbstractKeyword)) jsiiType.abstract = true;
    for (const h of decl.heritageClauses ?? []) {
      const isExtends = h.token === SyntaxKind.ExtendsKeyword;
      for (const t of h.types) {
        const hSym0 = checker.getSymbolAtLocation(t.expression);
        const hSym = hSym0 ? resolveAlias(hSym0) : undefined;
        const fqnRef = hSym ? (typeFqnBySymbolId.get(hSym.id) ?? externalFqnOf(hSym)) : undefined;
        if (!fqnRef) continue;
        if (isExtends) jsiiType.base = fqnRef;
        else (jsiiType.interfaces ??= []).push(fqnRef);
      }
    }
    const ctor = decl.members?.find((m) => m.kind === SyntaxKind.Constructor);
    const ctorPrivate = ctor && (ctor.modifiers ?? []).some((x) => x.kind === SyntaxKind.PrivateKeyword);
    if (ctorPrivate) {
      // private constructor: jsii omits the initializer
    } else if (ctor) {
      const sig = checker.getSignatureFromDeclaration(ctor);
      const initializer = { locationInModule: locOf(ctor) };
      if (sig) {
        const params = sig.getParameters().map(paramOf);
        if (params.length) initializer.parameters = params;
        if (params.some((p) => p.variadic)) initializer.variadic = true;
      }
      if ((ctor.modifiers ?? []).some((x) => x.kind === SyntaxKind.ProtectedKeyword)) initializer.protected = true;
      jsiiType.initializer = withDefaultDocs(initializer);
    } else {
      const init = {};
      if (defaultStability) init.docs = { stability: defaultStability };
      jsiiType.initializer = init;
    }
    membersOfClassLike(sym, decl, jsiiType, false);
  }
  types[fqn] = jsiiType;
}

const t2 = performance.now();

const dependencies = {};
for (const [dep] of externalDeps) {
  const v = (pkg.dependencies ?? {})[dep] ?? (pkg.peerDependencies ?? {})[dep];
  if (v) dependencies[dep] = v;
}

const assembly = {
  author: pkg.author ?? {},
  ...(Object.keys(dependencies).length ? { dependencies } : {}),
  ...(Object.keys(submodules).length ? { submodules } : {}),
  description: pkg.description ?? assemblyName,
  homepage: pkg.homepage,
  jsiiVersion: 'assembler-lite-proto (TS7)',
  license: pkg.license,
  name: assemblyName,
  repository: pkg.repository,
  schema: 'jsii/0.10.0',
  types,
  version: pkg.version,
};

console.error(JSON.stringify({
  loadMs: +(t1 - t0).toFixed(1),
  assembleMs: +(t2 - t1).toFixed(1),
  typeCount: Object.keys(types).length,
}));
console.log(JSON.stringify(assembly, null, 2));
snapshot.dispose();
api.close();

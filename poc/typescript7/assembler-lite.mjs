// assembler-lite: a minimal jsii Assembler reimplemented on the TypeScript 7 API.
// Produces a .jsii-like assembly JSON for a package and prints timing to stderr.
//
// Usage: node assembler-lite.mjs <packageRoot> [entry] > assembly.json
// Env:   TSGO_PATH — path to the (patched) tsgo binary
//        NP_LIB    — path to the built native-preview package dir
import * as fs from 'node:fs';
import * as path from 'node:path';

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

function resolveAlias(sym) {
  let s = sym;
  while ((s.flags & SymbolFlags.Alias) !== 0) s = checker.getAliasedSymbol(s);
  return s;
}

const exported = [];
for (const e of moduleExports) {
  const sym = resolveAlias(e);
  const decl = sym.declarations?.[0]?.resolve(project);
  if (!decl) continue;
  if ([SyntaxKind.ClassDeclaration, SyntaxKind.InterfaceDeclaration, SyntaxKind.EnumDeclaration].includes(decl.kind)) {
    const fqn = `${assemblyName}.${e.name}`;
    typeFqnBySymbolId.set(sym.id, fqn);
    exported.push({ name: e.name, sym, decl, fqn });
  }
}

const defaultStability = pkg.stability;
function docsOf(sym) {
  const summaryRaw = sym.getDocumentationComment(checker);
  const docs = {};
  if (summaryRaw) {
    const text = summaryRaw.trim();
    const m = /^([\s\S]*?\.)\s+([\s\S]+)$/.exec(text);
    const summary = m ? m[1] : text;
    if (m) docs.remarks = m[2].trim();
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
  const rel = path.relative(root, m[1]);
  return `${rel}:${m[2] ?? ''}`;
}

function isInternal(sym) {
  return sym.getJsDocTags(checker).some((t) => t.name === 'internal') || sym.name.startsWith('_');
}

function typeRefOf(type, optionalOut) {
  if (!type) return { primitive: 'any' };
  const f = type.flags;
  if (f & TypeFlags.EnumLike) {
    const s = type.getSymbol();
    const fqn = s && (typeFqnBySymbolId.get(s.id) ?? (s.getParent() && typeFqnBySymbolId.get(s.getParent().id)));
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
    const fqn = typeFqnBySymbolId.get(tsym.id);
    if (fqn) return { fqn };
  }
  const indexInfos = checker.getIndexInfosOfType(type);
  if (indexInfos.length) {
    return { collection: { elementtype: typeRefOf(indexInfos[0].type), kind: 'map' } };
  }
  return { primitive: 'any' };
}

function paramOf(prm) {
  const decl = prm.declarations?.[0]?.resolve(project);
  const t = decl ? checker.getTypeOfSymbolAtLocation(prm, decl) : undefined;
  const opt = {};
  const p = { name: prm.name, type: typeRefOf(t, opt) };
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
  if (!defaultStability) return obj;
  if (!obj.docs) obj.docs = { stability: defaultStability };
  else if (!obj.docs.stability) obj.docs.stability = defaultStability;
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
    const ret = typeRefOf(checker.getReturnTypeOfSignature(sig), opt);
    if (ret) m.returns = opt.optional ? { optional: true, type: ret } : { type: ret };
  }
  const d = docsOf(msym);
  if (d) m.docs = d;
  return withDefaultDocs(m);
}

function propOf(psym, decl, isStatic) {
  const t = checker.getTypeOfSymbolAtLocation(psym, decl);
  const opt = {};
  const p = { locationInModule: locOf(decl), name: psym.name, type: typeRefOf(t, opt) };
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
    const pDecl = p.declarations?.[0]?.resolve(project);
    if (!pDecl) continue;
    if ((pDecl.modifiers ?? []).some((x) => x.kind === SyntaxKind.PrivateKeyword)) continue;
    if (!isInterface && pDecl.parent !== decl) continue; // own members only for classes
    if (isInterface && pDecl.parent !== decl) continue;  // jsii lists inherited iface members via `interfaces`
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
  withDefaultDocs(jsiiType);
  const symbolId = symbolIdOf(sym);
  if (symbolId) jsiiType.symbolId = symbolId;

  if (decl.kind === SyntaxKind.EnumDeclaration) {
    jsiiType.kind = 'enum';
    const members = [];
    for (const [, msym] of sym.getExports()) {
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
      .map((b) => typeFqnBySymbolId.get(b.getSymbol()?.id))
      .filter(Boolean);
    if (bases.length) jsiiType.interfaces = bases;
    membersOfClassLike(sym, decl, jsiiType, true);
    if (!jsiiType.methods && !name.startsWith('I') && (jsiiType.properties ?? []).every((p) => p.immutable)) {
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
        const fqnRef = hSym ? typeFqnBySymbolId.get(hSym.id) : undefined;
        if (!fqnRef) continue;
        if (isExtends) jsiiType.base = fqnRef;
        else (jsiiType.interfaces ??= []).push(fqnRef);
      }
    }
    const ctor = decl.members?.find((m) => m.kind === SyntaxKind.Constructor);
    if (ctor) {
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

const assembly = {
  author: pkg.author ?? {},
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

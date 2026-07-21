// Full assembler-like walk using tsgo native-preview sync API.
import { API, SymbolFlags } from '@typescript/native-preview/unstable/sync';
import { SyntaxKind } from '@typescript/native-preview/unstable/ast';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ?? path.join(ROOT, 'fixture-large');
const t0 = performance.now();
const api = new API({ cwd: root, collectTiming: true });
const snapshot = api.updateSnapshot({ openProjects: [`${root}/tsconfig.json`] });
const project = snapshot.getProject(`${root}/tsconfig.json`);
const { program, checker } = project;
const t1 = performance.now();

const entry = program.getSourceFile(`${root}/lib/index.ts`);
const moduleSymbol = checker.getSymbolAtLocation(entry);
const moduleExports = checker.getExportsOfModule(moduleSymbol);

let stats = { types: 0, members: 0, docs: 0, sigs: 0, consts: 0 };

function resolveAlias(sym) {
  let s = sym;
  while ((s.flags & SymbolFlags.Alias) !== 0) s = checker.getAliasedSymbol(s);
  return s;
}
function docsOf(sym) {
  const c = sym.getDocumentationComment(checker);
  const t = sym.getJsDocTags(checker);
  stats.docs++;
  return { c, t };
}

for (const exportSym of moduleExports) {
  const sym = resolveAlias(exportSym);
  const decl = sym.declarations?.[0]?.resolve(project);
  if (!decl) continue;
  stats.types++;
  docsOf(sym);
  if (decl.kind === SyntaxKind.ClassDeclaration || decl.kind === SyntaxKind.InterfaceDeclaration) {
    const type = checker.getTypeAtLocation(decl);
    type.getBaseTypes();
    for (const p of checker.getPropertiesOfType(type)) {
      stats.members++;
      docsOf(p);
      const pDecl = p.declarations?.[0]?.resolve(project);
      if ((p.flags & SymbolFlags.Method) !== 0 && pDecl) {
        const sig = checker.getSignatureFromDeclaration(pDecl);
        if (sig) {
          stats.sigs++;
          for (const prm of sig.getParameters()) {
            const prmDecl = prm.declarations?.[0]?.resolve(project);
            if (prmDecl) checker.getTypeOfSymbolAtLocation(prm, prmDecl);
          }
          checker.getReturnTypeOfSignature(sig);
        }
      } else if (pDecl) {
        checker.getTypeOfSymbolAtLocation(p, pDecl);
      }
    }
    const ctorDecl = decl.members?.find((m) => m.kind === SyntaxKind.Constructor);
    if (ctorDecl) {
      const sig = checker.getSignatureFromDeclaration(ctorDecl);
      if (sig) for (const prm of sig.getParameters()) {
        const prmDecl = prm.declarations?.[0]?.resolve(project);
        if (prmDecl) checker.getTypeOfSymbolAtLocation(prm, prmDecl);
      }
    }
  } else if (decl.kind === SyntaxKind.EnumDeclaration) {
    for (const [, member] of sym.getExports()) {
      const mDecl = member.declarations?.[0]?.resolve(project);
      if (mDecl) { checker.getConstantValue(mDecl); stats.consts++; }
      docsOf(member);
    }
  }
}
const t2 = performance.now();
const diagCount = program.getSemanticDiagnostics().length + program.getSyntacticDiagnostics().length;
const t3 = performance.now();
const timing = api.getTimingInfo();
console.log(JSON.stringify({
  impl: 'tsgo-api',
  loadMs: +(t1 - t0).toFixed(1),
  walkMs: +(t2 - t1).toFixed(1),
  checkMs: +(t3 - t2).toFixed(1),
  diagCount,
  stats,
  rpc: timing.totals,
}, null, 1));
snapshot.dispose();
api.close();

// Same assembler-like walk using classic in-process TypeScript (strada) API.
import ts from 'typescript';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ?? path.join(ROOT, 'fixture-large');
const t0 = performance.now();
const configFile = ts.readConfigFile(`${root}/tsconfig.json`, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const checker = program.getTypeChecker();
const t1 = performance.now();

const entry = program.getSourceFile(path.join(root, 'lib/index.ts'));
const moduleSymbol = checker.getSymbolAtLocation(entry);
const moduleExports = checker.getExportsOfModule(moduleSymbol);

let stats = { types: 0, members: 0, docs: 0, sigs: 0, consts: 0 };

function resolveAlias(sym) {
  let s = sym;
  while ((s.flags & ts.SymbolFlags.Alias) !== 0) s = checker.getAliasedSymbol(s);
  return s;
}
function docsOf(sym) {
  sym.getDocumentationComment(checker);
  sym.getJsDocTags(checker);
  stats.docs++;
}

for (const exportSym of moduleExports) {
  const sym = resolveAlias(exportSym);
  const decl = sym.declarations?.[0];
  if (!decl) continue;
  stats.types++;
  docsOf(sym);
  if (ts.isClassDeclaration(decl) || ts.isInterfaceDeclaration(decl)) {
    const type = checker.getTypeAtLocation(decl);
    type.getBaseTypes?.();
    for (const p of checker.getPropertiesOfType(type)) {
      stats.members++;
      docsOf(p);
      const pDecl = p.declarations?.[0];
      if ((p.flags & ts.SymbolFlags.Method) !== 0 && pDecl) {
        const sig = checker.getSignatureFromDeclaration(pDecl);
        if (sig) {
          stats.sigs++;
          for (const prm of sig.getParameters()) {
            const prmDecl = prm.declarations?.[0];
            if (prmDecl) checker.getTypeOfSymbolAtLocation(prm, prmDecl);
          }
          sig.getReturnType();
        }
      } else if (pDecl) {
        checker.getTypeOfSymbolAtLocation(p, pDecl);
      }
    }
    const ctorDecl = decl.members?.find((m) => ts.isConstructorDeclaration(m));
    if (ctorDecl) {
      const sig = checker.getSignatureFromDeclaration(ctorDecl);
      if (sig) for (const prm of sig.getParameters()) {
        const prmDecl = prm.declarations?.[0];
        if (prmDecl) checker.getTypeOfSymbolAtLocation(prm, prmDecl);
      }
    }
  } else if (ts.isEnumDeclaration(decl)) {
    sym.exports?.forEach((member) => {
      const mDecl = member.declarations?.[0];
      if (mDecl) { checker.getConstantValue(mDecl); stats.consts++; }
      docsOf(member);
    });
  }
}
const t2 = performance.now();
const diagCount = ts.getPreEmitDiagnostics(program).length;
const t3 = performance.now();
console.log(JSON.stringify({
  impl: 'strada',
  loadMs: +(t1 - t0).toFixed(1),
  walkMs: +(t2 - t1).toFixed(1),
  checkMs: +(t3 - t2).toFixed(1),
  diagCount,
  stats,
}, null, 1));

// TypeScript 7.1 (`typescript/sync`) doc APIs over repro.ts, same output format
// as tsgo-jsdoc-param-run-classic.mjs for a mechanical diff. Needs only the
// typescript 7.1 package (installed as the `typescript7` alias) and a tsconfig.json
// in <root> that includes tsgo-jsdoc-param-repro.ts.
import * as path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
// Use 'typescript/package.json' instead when the project's own typescript is >= 7.1.
const tsDir = path.dirname(require.resolve('typescript7/package.json'));
const { API, SymbolFlags } = await import(path.join(tsDir, 'dist/api/sync/api.js'));
const { SyntaxKind } = await import(path.join(tsDir, 'dist/ast/index.js'));

const root = process.argv[2] ?? process.cwd();
const tsconfig = path.join(root, 'tsconfig.json');
const api = new API({ cwd: root });
const snapshot = api.createSnapshot({ openProjects: [tsconfig] });
const project = snapshot.getConfiguredProject(tsconfig);
const { program, checker } = project;
const sf = program.getSourceFile(path.join(root, 'tsgo-jsdoc-param-repro.ts'));
const modSym = checker.getSymbolAtLocation(sf);
const resolveAlias = (s) => { while ((s.flags & SymbolFlags.Alias) !== 0) s = checker.getAliasedSymbol(s); return s; };

for (const e of checker.getExportsOfModule(modSym)) {
  const sym = resolveAlias(e);
  const declH = sym.declarations?.[0];
  if (!declH || ![SyntaxKind.ClassDeclaration, SyntaxKind.InterfaceDeclaration].includes(declH.kind)) continue;
  const decl = declH.resolve(project);
  for (const member of decl.members ?? []) {
    const isCtor = member.kind === SyntaxKind.Constructor;
    const isMethod = member.kind === SyntaxKind.MethodDeclaration || member.kind === SyntaxKind.MethodSignature;
    if (!isCtor && !isMethod) continue;
    const sig = checker.getSignatureFromDeclaration(member);
    if (!sig) continue;
    const label = isCtor ? '<init>' : member.name?.text;
    for (const p of sig.getParameters()) {
      const doc = p.getDocumentationComment(checker) ?? '';
      const tags = (p.getJsDocTags(checker) ?? []).map((t) => `${t.name}=${t.text ?? ''}`);
      console.log(`${e.name}.${label} param ${p.name}: doc=${JSON.stringify(doc)} tags=${JSON.stringify(tags)}`);
    }
  }
}
snapshot.dispose();
api.close();

// Baseline: classic TypeScript (5.x / 6.x) doc APIs over repro.ts.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');

const file = process.argv[2] ?? './tsgo-jsdoc-param-repro.ts';
const program = ts.createProgram([file], { target: ts.ScriptTarget.ES2022, strict: true });
const checker = program.getTypeChecker();
const sf = program.getSourceFile(file);

for (const stmt of sf.statements) {
  if (!ts.isClassDeclaration(stmt) && !ts.isInterfaceDeclaration(stmt)) continue;
  const typeName = stmt.name.text;
  for (const member of stmt.members) {
    if (!ts.isMethodDeclaration(member) && !ts.isMethodSignature(member) && !ts.isConstructorDeclaration(member)) continue;
    const sig = checker.getSignatureFromDeclaration(member);
    if (!sig) continue;
    const label = ts.isConstructorDeclaration(member) ? '<init>' : member.name.getText();
    for (const p of sig.getParameters()) {
      const doc = ts.displayPartsToString(p.getDocumentationComment(checker));
      const tags = p.getJsDocTags(checker).map((t) => `${t.name}=${ts.displayPartsToString(t.text ?? [])}`);
      console.log(`${typeName}.${label} param ${p.name}: doc=${JSON.stringify(doc)} tags=${JSON.stringify(tags)}`);
    }
  }
}

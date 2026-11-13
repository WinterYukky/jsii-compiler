/**
 * The diagnostic model used throughout the compiler.
 *
 * TypeScript 7 no longer exposes the in-process `ts.Diagnostic` type (the
 * `typescript` package's main entry point only carries the version), so jsii
 * carries its own, deliberately minimal, equivalent. Category values match the
 * numeric `ts.DiagnosticCategory` values so that user-facing configuration
 * (`jsii.diagnostics` in `package.json`) keeps its meaning.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';

export enum DiagnosticCategory {
  Warning = 0,
  Error = 1,
  Suggestion = 2,
  Message = 3,
}

/** A source file a diagnostic points into. */
export interface DiagnosticSourceFile {
  readonly fileName: string;
  /** The full text of the file, when available (used to render source context). */
  readonly text?: string;
}

export interface Diagnostic {
  readonly category: DiagnosticCategory;
  readonly code: number;
  readonly messageText: string;
  readonly file?: DiagnosticSourceFile;
  /** Start offset (UTF-16 code units) within `file`. */
  readonly start?: number;
  readonly length?: number;
}

/** Converts an offset into a 0-based line/character pair. */
export function getLineAndCharacterOfPosition(text: string, position: number): { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < position && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: position - lineStart };
}

function categoryName(category: DiagnosticCategory): string {
  switch (category) {
    case DiagnosticCategory.Error:
      return 'error';
    case DiagnosticCategory.Warning:
      return 'warning';
    case DiagnosticCategory.Suggestion:
      return 'suggestion';
    default:
      return 'message';
  }
}

function categoryColor(category: DiagnosticCategory): (s: string) => string {
  switch (category) {
    case DiagnosticCategory.Error:
      return chalk.red;
    case DiagnosticCategory.Warning:
      return chalk.yellow;
    case DiagnosticCategory.Suggestion:
      return chalk.green;
    default:
      return chalk.blue;
  }
}

/**
 * Renders a diagnostic the way the classic compiler's
 * `formatDiagnosticsWithColorAndContext` does: a `file:line:col - category
 * TSxxxx: message` header followed, when the source is available, by the
 * offending line and a squiggle under the reported range.
 */
export function formatDiagnosticWithColorAndContext(diagnostic: Diagnostic, projectRoot: string): string {
  const color = categoryColor(diagnostic.category);
  const text = sourceText(diagnostic.file, diagnostic.start);
  let out = '';
  if (diagnostic.file) {
    out += formatLocation(diagnostic.file, text, diagnostic.start, projectRoot);
    out += ' - ';
  }
  out += `${color(categoryName(diagnostic.category))}${chalk.grey(` TS${diagnostic.code}: `)}${
    diagnostic.messageText
  }`;
  if (diagnostic.file && text != null && diagnostic.start != null) {
    out += '\n';
    out += formatCodeSpan(text, diagnostic.start, diagnostic.length ?? 0, '', color);
  }
  // Like the TypeScript formatter, a diagnostic that carries a (possibly empty)
  // list of related information gets an extra line after its code span.
  const related = (diagnostic as { relatedInformation?: readonly Diagnostic[] }).relatedInformation;
  if (related) {
    out += '\n';
    for (const info of related) {
      const infoText = sourceText(info.file, info.start);
      if (info.file) {
        out += '\n';
        out += `  ${formatLocation(info.file, infoText, info.start, projectRoot)}`;
        if (infoText != null && info.start != null) {
          out += formatCodeSpan(infoText, info.start, info.length ?? 0, '    ', chalk.cyan);
        }
      }
      out += '\n';
      out += `    ${info.messageText}`;
    }
  }
  out += '\n';
  return out;
}

function sourceText(file: DiagnosticSourceFile | undefined, start: number | undefined): string | undefined {
  if (file?.text != null) {
    return file.text;
  }
  if (file?.fileName && start != null) {
    try {
      return fs.readFileSync(file.fileName, 'utf8');
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function formatLocation(
  file: DiagnosticSourceFile,
  text: string | undefined,
  start: number | undefined,
  projectRoot: string,
): string {
  const relative = path.relative(projectRoot, file.fileName) || file.fileName;
  let out = chalk.cyan(relative);
  if (text != null && start != null) {
    const { line, character } = getLineAndCharacterOfPosition(text, start);
    out += `:${chalk.yellow(line + 1)}:${chalk.yellow(character + 1)}`;
  }
  return out;
}

/** Port of the TypeScript formatter's `formatCodeSpan`. */
function formatCodeSpan(
  text: string,
  start: number,
  length: number,
  indent: string,
  squiggleColor: (s: string) => string,
): string {
  const ellipsis = '...';
  const gutter = (s: string) => chalk.black.bgWhite(s);
  const { line: firstLine, character: firstLineChar } = getLineAndCharacterOfPosition(text, start);
  const { line: lastLine, character: lastLineChar } = getLineAndCharacterOfPosition(text, start + length);
  const lines = text.split('\n');
  const hasMoreThanFiveLines = lastLine - firstLine >= 4;
  let gutterWidth = String(lastLine + 1).length;
  if (hasMoreThanFiveLines) {
    gutterWidth = Math.max(ellipsis.length, gutterWidth);
  }
  let context = '';
  for (let i = firstLine; i <= lastLine; i++) {
    context += '\n';
    if (hasMoreThanFiveLines && firstLine + 1 < i && i < lastLine - 1) {
      context += `${indent}${gutter(ellipsis.padStart(gutterWidth))} \n`;
      i = lastLine - 1;
    }
    const lineContent = (lines[i] ?? '').replace(/\r$/, '').replace(/\s+$/g, '').replace(/\t/g, ' ');
    context += `${indent}${gutter(String(i + 1).padStart(gutterWidth))} ${lineContent}\n`;
    context += `${indent}${gutter(''.padStart(gutterWidth))} `;
    let squiggle: string;
    if (i === firstLine) {
      const lastCharForLine = i === lastLine ? lastLineChar : undefined;
      squiggle =
        lineContent.slice(0, firstLineChar).replace(/\S/g, ' ') +
        lineContent.slice(firstLineChar, lastCharForLine).replace(/./g, '~');
    } else if (i === lastLine) {
      squiggle = lineContent.slice(0, lastLineChar).replace(/./g, '~');
    } else {
      squiggle = lineContent.replace(/./g, '~');
    }
    context += squiggleColor(squiggle);
  }
  return context;
}

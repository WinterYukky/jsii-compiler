import { Diagnostic, DiagnosticCategory } from './diagnostic';
import { Directives } from './directives';
import { Code, JsiiDiagnostic } from './jsii-diagnostic';

/**
 * Set of silenced warning codes (numeric JSII codes).
 */
export const silencedWarnings = new Set<number>();

/**
 * Parse a user-provided warning identifier into numeric JSII codes.
 * Accepts: "JSII5019", "5019", or a diagnostic name / partial name.
 *
 * A name containing `/` must match a full diagnostic name exactly.
 * A name without `/` matches any diagnostic whose category or specific
 * name equals the input (e.g. "reserved-word" or "language-compatibility").
 */
export function parseWarningCodes(input: string): number[] {
  // JSII<number> format
  const jsiiMatch = /^JSII(\d+)$/i.exec(input);
  if (jsiiMatch) {
    return [parseInt(jsiiMatch[1], 10)];
  }

  // Plain number
  const num = parseInt(input, 10);
  if (String(num) === input) {
    return [num];
  }

  // Name-based lookup
  const matches = Code.lookupByPartialName(input);
  if (matches.length > 0) {
    return matches.map((c) => c.code);
  }

  throw new Error(
    `Unknown warning "${input}". Expected a JSII code (e.g. JSII5018), a number (e.g. 5018), or a diagnostic name (e.g. reserved-word, language-compatibility/reserved-word, language-compatibility).`,
  );
}

/**
 * Check if a diagnostic is a silenced warning (globally or inline).
 */
export function isSilenced(diagnostic: Diagnostic): boolean {
  if (diagnostic.category !== DiagnosticCategory.Warning) {
    return false;
  }
  if (!JsiiDiagnostic.isJsiiDiagnostic(diagnostic)) {
    return false;
  }
  if (silencedWarnings.has(diagnostic.jsiiCode)) {
    return true;
  }
  return isInlineSuppressed(diagnostic);
}

/**
 * Check if a diagnostic is suppressed inline via a `@jsii suppress` directive.
 *
 * Diagnostics reference a source position (typically the name identifier of a
 * declaration), but JSDoc tags are attached to the enclosing declaration node,
 * not the identifier. We therefore start at the node the diagnostic was created
 * from and walk up the AST, checking each ancestor for `@jsii suppress`
 * directives. This means a directive on a class suppresses matching warnings
 * on all its members.
 */
function isInlineSuppressed(diagnostic: JsiiDiagnostic): boolean {
  let current: any = diagnostic.node;
  while (current) {
    const directives = Directives.of(current, () => {});
    for (const code of directives.suppressions) {
      try {
        if (parseWarningCodes(code).includes(diagnostic.jsiiCode)) {
          return true;
        }
      } catch {
        // Unknown code — ignore
      }
    }
    current = current.parent;
  }
  return false;
}

import { JsiiDiagnostic } from './jsii-diagnostic';

/**
 * The parts of an AST node the directive parser reads. Any declaration node of
 * the `#typescript/ast` module satisfies this (the JSDoc blocks attached to a
 * declaration are available client-side as `node.jsDoc`).
 */
export interface JsDocHost {
  readonly jsDoc?: readonly JsDocBlock[];
}

export interface JsDocBlock {
  readonly tags?: readonly JsDocTag[];
}

export interface JsDocTag {
  readonly tagName: { readonly text: string };
  readonly comment?: string | readonly JsDocCommentPart[];
}

export interface JsDocCommentPart {
  readonly text: string;
  /** Set on `{@link ...}` parts (JSDocLink, JSDocLinkCode, JSDocLinkPlain). */
  readonly name?: { getText(sourceFile?: unknown): string; getSourceFile(): unknown };
}

/**
 * TSDoc-style directives that can be attached to a symbol.
 */
export class Directives {
  /**
   * Obtains the `Directives` for a given TypeScript AST node.
   *
   * @param node         the node for which directives are requested.
   * @param onDiagnostic a callback invoked whenever a diagnostic message is
   *                     emitted when parsing directives.
   */
  public static of(node: JsDocHost, onDiagnostic: (diag: JsiiDiagnostic) => void): Directives {
    const found = Directives.#CACHE.get(node);
    if (found != null) {
      return found;
    }

    const directives = new Directives(node, onDiagnostic);
    Directives.#CACHE.set(node, directives);
    return directives;
  }

  static readonly #CACHE = new WeakMap<JsDocHost, Directives>();

  /** Whether the node has the `@internal` JSDoc tag. */
  public readonly tsInternal?: JsDocTag;
  /** Whether the node has the `@jsii ignore` directive set. */
  public readonly ignore?: JsDocCommentPart | JsDocTag;
  /** Whether the node has the `@jsii struct` directive set. */
  public readonly struct?: JsDocCommentPart | JsDocTag;
  /** Suppression codes from `@jsii suppress <code>` directives. */
  public readonly suppressions: readonly string[] = [];

  private constructor(node: JsDocHost, onDiagnostic: (diag: JsiiDiagnostic) => void) {
    const suppressions: string[] = [];
    for (const tag of getJSDocTags(node)) {
      switch (tag.tagName.text) {
        case 'internal':
          this.tsInternal ??= tag;
          break;
        case 'jsii':
          const comments = getComments(tag);
          if (comments.length === 0) {
            onDiagnostic(JsiiDiagnostic.JSII_2000_MISSING_DIRECTIVE_ARGUMENT.create(tag as any));
            continue;
          }
          for (const { text, jsdocNode } of comments) {
            const [subcommand, ...rest] = text.split(/\s+/);
            switch (subcommand) {
              case 'ignore':
                this.ignore ??= jsdocNode;
                break;
              case 'suppress': {
                const code = rest[0];
                if (code) {
                  suppressions.push(code);
                }
                break;
              }
              default:
                onDiagnostic(JsiiDiagnostic.JSII_2999_UNKNOWN_DIRECTIVE.create(jsdocNode as any, text));
                break;
            }
          }
          break;
        default: // Ignore
      }
    }
    this.suppressions = suppressions;
  }
}

/**
 * The JSDoc tags attached to a declaration node (the tags of its own JSDoc
 * blocks). Same result as `getJSDocTags` of the AST module for declarations,
 * without depending on a particular TypeScript version's node classes.
 */
function getJSDocTags(node: JsDocHost): readonly JsDocTag[] {
  return (node.jsDoc ?? []).flatMap((block) => block.tags ?? []);
}

function getComments(tag: JsDocTag): Comment[] {
  if (tag.comment == null) {
    return [];
  }

  if (typeof tag.comment === 'string') {
    const text = tag.comment.trim();
    return text
      ? text.split(/[\n,]/).flatMap((line) => {
          line = line.trim();
          return line ? [{ text: line, jsdocNode: tag }] : [];
        })
      : [];
  }

  return tag.comment.flatMap((jsdocNode): Comment[] => {
    // `{@link Name text}` parts carry a name; plain text parts do not.
    const text = (
      jsdocNode.name != null ? `${jsdocNode.name.getText(jsdocNode.name.getSourceFile())}: ${jsdocNode.text}` : jsdocNode.text
    ).trim();
    return text ? [{ text, jsdocNode }] : [];
  });
}

interface Comment {
  readonly text: string;
  readonly jsdocNode: JsDocCommentPart | JsDocTag;
}

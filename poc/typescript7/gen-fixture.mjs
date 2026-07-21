// Generate a synthetic jsii-like library with N types to test RPC scaling.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const N = Number(process.argv[2] ?? 500);
const dir = path.join(ROOT, 'fixture-large/lib');
fs.rmSync(path.join(ROOT, 'fixture-large'), { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const indexLines = [];
for (let i = 0; i < N; i++) {
  const src = `${i > 0 ? `import { Widget${i - 1}, Widget${i - 1}Props } from './widget${i - 1}';\n` : ''}
/** Props for Widget${i}. */
export interface Widget${i}Props {
  /** The name. @default none */
  readonly name?: string;
  /** The count. */
  readonly count: number;
  /** Nested reference. */
  readonly other?: ${i > 0 ? `Widget${i - 1}Props` : 'string'};
}

/** Behaviour marker for Widget${i}. */
export interface IWidget${i} {
  /** Do the thing. */
  frob(amount: number): string;
}

/** Enum for Widget${i}. */
export enum Widget${i}Kind {
  /** Alpha kind. */
  ALPHA = 1,
  /** Beta kind. @deprecated gone */
  BETA = 2,
}

/**
 * A construct-like class number ${i}.
 * @example new Widget${i}('id', { count: 1 })
 */
export class Widget${i} ${i % 5 !== 0 ? `extends Widget${i - 1}` : ''} implements IWidget${i} {
  /** Static thing. */
  public static readonly DEFAULT_COUNT: number = ${i};
  /** Kind of widget. */
  public readonly kind${i}: Widget${i}Kind = Widget${i}Kind.ALPHA;
  public constructor(id: string, props: Widget${i}Props) {
    ${i % 5 !== 0 ? `super(id, { count: props.count, name: id });` : 'void id; void props;'}
  }
  public frob(amount: number): string { return \`w${i}-\${amount}\`; }
  /** Method specific to ${i}. */
  public method${i}(input: Widget${i}Props): Widget${i}Kind { void input; return Widget${i}Kind.ALPHA; }
}
`;
  fs.writeFileSync(path.join(dir, `widget${i}.ts`), src);
  indexLines.push(`export * from './widget${i}';`);
}
fs.writeFileSync(path.join(dir, 'index.ts'), indexLines.join('\n') + '\n');
fs.writeFileSync(path.join(ROOT, 'fixture-large/tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'ES2022', module: 'node16', moduleResolution: 'node16',
    declaration: true, strict: true, outDir: 'dist', types: [],
  },
  include: ['lib/**/*.ts'],
}, null, 2));
console.log(`generated ${N} widget modules (${N * 4} exported types)`);

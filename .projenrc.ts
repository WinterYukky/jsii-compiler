import { javascript, JsonPatch, github, typescript, YamlFile } from 'projen';
import { BuildWorkflow } from './projenrc/build-workflow';
import { JsiiCalcFixtures } from './projenrc/fixtures';
import { ReleaseWorkflow } from './projenrc/release';
import { PREVIEW_RELEASES, SUPPORT_POLICY, SupportPolicy } from './projenrc/support';
import { UpdateIntegPackage } from './projenrc/update-integ-package';
import { UpgradeDependencies } from './projenrc/upgrade-dependencies';

//  See 'projenrc/support.ts' for TypeScript versions we are tracking.
//  To add a new TypeScript version, follow the complete process documented in:
//  .kiro/steering/new-typescript-release.md

const workflowNodeVersion = 'lts/*';

const project = new typescript.TypeScriptProject({
  name: 'jsii',
  license: 'Apache-2.0',
  authorName: 'Amazon Web Services',
  authorUrl: 'https://aws.amazon.com',
  homepage: 'https://aws.github.io/jsii',
  repository: 'https://github.com/aws/jsii-compiler.git',

  projenrcTs: true,
  runner: typescript.TypeScriptRunner.tsx({ typeCheck: true }),

  packageManager: javascript.NodePackageManager.YARN_BERRY,
  yarnBerryOptions: {
    // Yarn patches `typescript` on install to support Plug'n'Play. Before 4.17.1, that patch fails on TypeScript 7,
    // which no longer ships the JavaScript compiler files the patch edits.
    version: '4.18.1',
    yarnRcOptions: {
      nodeLinker: javascript.YarnNodeLinker.NODE_MODULES,
    },
  },

  pullRequestTemplateContents: [
    '',
    '',
    '---',
    '',
    'By submitting this pull request, I confirm that my contribution is made under the terms of the [Apache 2.0 license].',
    '',
    '[Apache 2.0 license]: https://www.apache.org/licenses/LICENSE-2.0',
  ],

  autoDetectBin: true,

  minNodeVersion: '22.12.0', // Node.js 22 LTS
  tsconfig: {
    compilerOptions: {
      // @see https://github.com/microsoft/TypeScript/wiki/Node-Target-Mapping
      lib: ['es2023'],
      target: 'ES2023',

      noImplicitOverride: true,
      skipLibCheck: true,
      moduleResolution: javascript.TypeScriptModuleResolution.NODE_NEXT,
      module: 'node20',
      isolatedModules: true,

      sourceMap: true,
      inlineSourceMap: false,
      inlineSources: true,
    },
  },
  tsconfigDev: {
    compilerOptions: {
      moduleResolution: 'nodenext' as javascript.TypeScriptModuleResolution,
      module: 'node20',
    },
  },

  // Linting and formatting are done by Biome. ESLint (through
  // @typescript-eslint/typescript-estree) requires the in-process TypeScript
  // compiler API, which the TypeScript 7 package no longer ships.
  eslint: false,
  prettier: false,
  biome: true,
  biomeOptions: {
    version: '^2.6',
    biomeConfig: {
      formatter: {
        // Carried over from the Prettier configuration
        indentStyle: javascript.biome_config.IndentStyle.SPACE,
        indentWidth: 2,
        lineWidth: 120,
      },
      javascript: {
        formatter: {
          bracketSpacing: true,
          quoteStyle: javascript.biome_config.QuoteStyle.SINGLE,
          // Prettier's `quoteProps: consistent` has no Biome equivalent; `preserve` keeps the existing quoting.
          quoteProperties: javascript.biome_config.QuoteProperties.PRESERVE,
          semicolons: javascript.biome_config.Semicolons.ALWAYS,
          trailingCommas: javascript.biome_config.JsTrailingCommas.ALL,
        },
      },
      linter: {
        rules: {
          complexity: {
            // dot-notation
            useLiteralKeys: 'error',
            // unicorn/no-array-for-each
            noForEach: 'error',
          },
          correctness: {
            // import/no-extraneous-dependencies
            noUndeclaredDependencies: {
              level: 'error',
              options: {
                devDependencies: ['**/test/**', '**/build-tools/**', '**/projenrc/**', '.projenrc.ts'],
                optionalDependencies: false,
                peerDependencies: true,
              },
            },
          },
          style: {
            // @typescript-eslint/no-require-imports
            noCommonJs: 'error',
            // unicorn/prefer-node-protocol
            useNodejsImportProtocol: 'error',
            // curly [multi-line, consistent] allows single-line bodies; Biome's rule does not.
            useBlockStatements: 'off',
          },
          suspicious: {
            // @typescript-eslint/no-shadow. Biome's rule also reports a type parameter
            // of a static method shadowing the class's, and the key of an index
            // signature, which typescript-eslint did not; 8 of its 9 findings on this
            // code base are of that kind.
            noShadow: 'off',
          },
        },
      },
    },
  },

  jestOptions: {
    configFilePath: 'jest.config.json',
    jestConfig: {
      moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
      watchPathIgnorePatterns: [
        // NB: Those are regexes...
        '<rootDir>/fixtures/\\..*',
        '<rootDir>/fixtures/node_modules',
        '<rootDir>/fixtures/.*\\.d\\.ts',
        '<rootDir>/fixtures/.*\\.js',
        '<rootDir>/fixtures/.*\\.map',
      ],
    },
    junitReporting: false,
  },

  buildWorkflow: false, // We have our own build workflow (need matrix test)
  release: false, // We have our own release workflow
  defaultReleaseBranch: 'main',
  workflowNodeVersion,

  autoApproveUpgrades: true,
  autoApproveOptions: {
    allowedUsernames: ['aws-cdk-automation', 'github-bot'],
  },

  depsUpgrade: false, // We have our own custom upgrade workflow

  vscode: true,
});

// PR validation should run on merge group, too...
(project.tryFindFile('.github/workflows/pull-request-lint.yml')! as YamlFile).patch(
  JsonPatch.add('/on/merge_group', {}),
  JsonPatch.add(
    '/jobs/validate/steps/0/if',
    "github.event == 'pull_request' || github.event_name == 'pull_request_target'",
  ),
);

new UpgradeDependencies(project, {
  cooldown: 3,
  workflowOptions: {
    branches: [
      'main',
      ...Object.entries(SUPPORT_POLICY.maintenance).flatMap(([version, until]) => {
        if (Date.now() > until.getTime()) {
          return [];
        }
        return [`maintenance/v${version}`];
      }),
      ...PREVIEW_RELEASES.map((version) => `preview/v${version}`),
    ],
    labels: ['auto-approve'],
  },
});

project.tsconfig?.file?.patch(
  JsonPatch.add('/compilerOptions/composite', true),
  JsonPatch.add('/compilerOptions/declarationMap', true),
);
project.tryFindObjectFile('projenrc/tsconfig.json')?.patch(
  // projenrc/support.ts needs these files
  JsonPatch.add('/include/-', '../src/support.ts'),
  JsonPatch.add('/include/-', '../src/version.ts'),
);

// Don't show .gitignore'd files in the VSCode explorer
project.vscode!.settings.addSetting('explorer.excludeGitIgnore', true);
// Use the TypeScript SDK from the project dependencies
project.vscode!.settings.addSetting('typescript.tsdk', 'node_modules/typescript/lib');
// Format-on-save using Biome
project.vscode!.extensions.addRecommendations('biomejs.biome');
project.vscode!.settings.addSetting('editor.defaultFormatter', 'biomejs.biome');
project.vscode!.settings.addSetting('editor.formatOnSave', true);
project.vscode!.settings.addSetting('editor.codeActionsOnSave', {
  'source.fixAll.biome': 'explicit',
  'source.organizeImports.biome': 'explicit',
});

// Exports map...
project.package.addField('exports', {
  '.': `./${project.package.entrypoint}`,
  './bin/jsii': './bin/jsii',
  './package.json': './package.json',
  './common': './lib/common/index.js',
});

// Remove TypeScript devDependency (it's a direct/normal dependency here)
project.deps.removeDependency('typescript');

// Modernize ts-jest configuration
if (project.jest?.config) {
  project.jest.config.transform ??= {};
  project.jest.config.transform['^.+\\.[t]sx?$'] = [
    'ts-jest',
    {
      compiler: 'typescript',
      tsconfig: 'test/tsconfig.json',
      diagnostics: { ignoreCodes: ['TS151001'] },
    },
  ];
}

// Add fixtures & other exemptions to npmignore
project.npmignore?.addPatterns(
  '/.*',
  '/CODE_OF_CONDUCT.md',
  '/CONTRIBUTING.md',
  '/build-tools/',
  '/fixtures/',
  '/logo/',
  '/projenrc/',
  '*.tsbuildinfo',
  '*.d.ts.map', // Declarations map aren't useful in published packages.
);

project.addDeps(
  '@jsii/check-node',
  '@jsii/spec',
  'case',
  'chalk@^4',
  'fast-deep-equal',
  'log4js',
  'semver',
  'semver-intersect',
  'sort-json',
  'spdx-license-list',
  `typescript@7.1.0-beta`,
  'yargs',
);

project.addDevDeps(
  '@actions/core',
  '@actions/github',
  '@types/clone',
  '@types/deep-equal',
  '@types/lockfile',
  '@types/semver',
  'clone',
  'fast-check',
  'jsii-1.x@npm:jsii@1',
  'lockfile',
  'tsx',
  'glob',
);

project.preCompileTask.exec('tsx build-tools/code-gen.ts', {
  name: 'code-gen',
});
project.gitignore.addPatterns('/src/version.ts', '/jsii-outdir/', '/test/negatives/.*');
project.gitignore.exclude('.DS_Store', '.lock');

// Exclude negatives from tsconfig and Biome...
project.tsconfigDev.addExclude('test/negatives/**/*.ts');
project.tsconfigDev.addInclude('build-tools/**/*.ts');

// Biome scope: the same paths ESLint used to run on (projen adds src/** and test/**)
project.biome!.addFilePattern('build-tools/**');
project.biome!.addFilePattern('projenrc/**');
project.biome!.addFilePattern('.projenrc.ts');
project.biome!.addFilePattern('!test/negatives');
project.biome!.addFilePattern('!**/*.generated.ts');
project.biome!.addFilePattern('!test/**/__snapshots__');
// ESLint/Prettier only ran on TypeScript sources; keep Markdown out of Biome's scope as well
project.biome!.addFilePattern('!**/*.md');

// Rules of Biome's recommended set that ESLint did not enforce here and the code
// base does not follow (the count is the number of findings when this was set
// up). They are turned off so that the switch from ESLint does not change any
// source file; each can be enabled in its own change.
project.biome!.expandLinterRules({
  complexity: {
    noBannedTypes: 'off', // 2
    noStaticOnlyClass: 'off', // 2
    noThisInStatic: 'off', // 10
    noUselessContinue: 'off', // 1
    noUselessSwitchCase: 'off', // 1
    noUselessTernary: 'off', // 1
    noUselessTypeConstraint: 'off', // 1
    useArrowFunction: 'off', // 11
    useOptionalChain: 'off', // 4
  },
  correctness: {
    noSwitchDeclarations: 'off', // 1
  },
  performance: {
    noAccumulatingSpread: 'off', // 3
  },
  style: {
    noNonNullAssertion: 'off', // 207
    useArrayLiterals: 'off', // 28
    useConst: 'off', // 4
    useImportType: 'off', // 59
    useTemplate: 'off', // 5
  },
  suspicious: {
    noConstEnum: 'off', // 1
    noDoubleEquals: 'off', // 8, two of them intentionally loose (tsconfig validator)
    noExplicitAny: 'off', // 99
    noGlobalIsNan: 'off', // 3
    noIdenticalTestTitle: 'off', // 1
    noImplicitAnyLet: 'off', // 8, `let x;` whose type TypeScript infers from the assignments
    noShadowRestrictedNames: 'off', // 1
    noTemplateCurlyInString: 'off', // 82
  },
});

// .projenrc.ts may require() and use any dependency (same exemptions as before)
project.biome!.addOverride({
  includes: ['.projenrc.ts'],
  linter: {
    rules: {
      correctness: { noUndeclaredDependencies: 'off' },
      style: { noCommonJs: 'off' },
    },
  },
});

// Register jsii-calc stuff in the work stream
new JsiiCalcFixtures(project);

// Add Node.js version matrix test
new BuildWorkflow(project);

// Add support policy documents & release workflows
const supported = new SupportPolicy(project);
const releases = new ReleaseWorkflow(project, { workflowNodeVersion })
  .autoTag({
    releaseLine: SUPPORT_POLICY.current,
    preReleaseId: 'dev',
    runName: 'Auto-Tag Prerelease (default branch)',
    schedule: '0 0 * * 0,2-6', // Tuesday though sundays at midnight
  })
  .autoTag({
    releaseLine: SUPPORT_POLICY.current,
    runName: 'Auto-Tag Release (default branch)',
    schedule: '0 0 * * 1', // Mondays at midnight
  });

// We'll stagger release schedules so as to avoid everything going out at once.
let hour = 0;
for (const [version, branch] of Object.entries(supported.activeBranches(false))) {
  // Stagger schedules every 5 hours, rolling. 5 was selected because it's co-prime to 24.
  hour = (hour + 5) % 24;
  const tag = `v${version}`;
  releases
    .autoTag({
      releaseLine: version,
      preReleaseId: 'dev',
      runName: `Auto-Tag Prerelease (${tag})`,
      schedule: `0 ${hour} * * 0,2-6`, // Tuesday though sundays
      branch,
      nameSuffix: tag,
    })
    .autoTag({
      releaseLine: version,
      runName: `Auto-Tag Release (${tag})`,
      schedule: `0 ${hour} * * 1`, // Mondays
      branch,
      nameSuffix: tag,
    });
}

// Preview release lines only get dev pre-releases, never full releases.
for (const [version, branch] of Object.entries(supported.previewBranches)) {
  hour = (hour + 5) % 24;
  const tag = `v${version}`;
  releases.autoTag({
    releaseLine: version,
    preReleaseId: 'dev',
    runName: `Auto-Tag Prerelease (${tag} preview)`,
    schedule: `0 ${hour} * * 0,2-6`, // Tuesday though sundays
    branch,
    nameSuffix: tag,
  });
}

// Allow PR backports to all maintained versions
new github.PullRequestBackport(project, {
  branches: Object.values(supported.activeBranches()),
});

new UpdateIntegPackage(project);

project.synth();

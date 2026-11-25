import globals from 'globals';
import typescript from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';

export default [
  { ignores: ['**/vendor/*'] },
  {
    files: ['**/*.{js,jsx,ts,tsx,mts,cts}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        project: ['./packages/*/tsconfig.eslint.json'],
      },
      globals: {
        ...globals.browser,
        ...globals.es2021,
      },
    },

    plugins: {
      '@typescript-eslint': typescript,
      import: importPlugin,
    },

    settings: {
      'import/parsers': {
        '@typescript-eslint/parser': ['.ts', '.tsx', '.mts', '.cts'],
      },
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: 'packages/*/tsconfig.json',
        },
        node: {
          extensions: ['.js', '.jsx', '.ts', '.tsx', '.mts', '.cts'],
        },
      },
    },

    rules: {
      // Basic ESLint rules
      semi: ['error', 'always'],
      eqeqeq: ['error', 'smart'],
      'generator-star-spacing': 'off',
      'no-async-promise-executor': 'error',
      'no-void': 'off',
      'prefer-const': 'error',
      'eol-last': 'off',
      'no-extra-boolean-cast': 'off',
      'no-prototype-builtins': 'off',
      'no-undef-init': 'off',
      'spaced-comment': 'off',
      'padded-blocks': 'off',
      'multiline-ternary': 'off',
      'no-trailing-spaces': 'off',
      'yield-star-spacing': 'off',
      'no-unneeded-ternary': 'off',
      'no-case-declarations': 'off',
      'no-useless-return': 'off',

      // Import plugin rules
      'import/no-duplicates': 'error',
      'import/no-cycle': 'error',
      'import/first': 'off',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/core/src',
                '**/core/src/**',
                '@valerypopoff/rivet2-core/src',
                '@valerypopoff/rivet2-core/src/**',
              ],
              message:
                'Import core through @valerypopoff/rivet2-core. If a package needs a shared core contract, export it intentionally from core first.',
            },
          ],
        },
      ],

      // TypeScript-specific rules
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
        },
      ],
      '@typescript-eslint/no-empty-interface': 'off',
      '@typescript-eslint/no-extra-parens': 'off',
      '@typescript-eslint/semi': 'off',
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/space-before-function-paren': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/comma-dangle': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/member-delimiter-style': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/strict-boolean-expressions': 'off',
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/prefer-reduce-type-parameter': 'off',
      '@typescript-eslint/prefer-ts-expect-error': 'off',
      '@typescript-eslint/indent': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/method-signature-style': 'off',
      '@typescript-eslint/return-await': 'off',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-indexed-object-style': 'off',
      '@typescript-eslint/prefer-optional-chain': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/promise-function-async': 'off',
      '@typescript-eslint/lines-between-class-members': 'off',
      '@typescript-eslint/ban-types': 'off',
      '@typescript-eslint/quotes': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      '@typescript-eslint/consistent-generic-constructors': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'off',
      '@typescript-eslint/no-implied-eval': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-dynamic-delete': 'off',
      '@typescript-eslint/no-invalid-void-type': 'off',
      '@typescript-eslint/no-throw-literal': 'off',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'off',
      '@typescript-eslint/triple-slash-reference': 'off',
    },
  },

  // The hosted upgrade screen is outside the desktop app's TypeScript project.
  {
    files: [
      'packages/studio-server-web/dashboard/app-settings/tabs/LocalStorageUpgradeSettingsTab.tsx',
      'packages/studio-server-web/dashboard/app-settings/tabs/localStorageUpgradeModel.ts',
      'packages/studio-server-web/dashboard/app-settings/tabs/useLocalStorageUpgradeController.ts',
      'packages/studio-server-web/tests/local-storage-upgrade-model.test.ts',
    ],
    languageOptions: {
      parserOptions: { project: ['./packages/studio-server-web/tsconfig.local-storage-upgrade.json'] },
    },
  },

  // Publication review owners have a focused hosted-web TypeScript project.
  {
    files: [
      'packages/studio-server-web/dashboard/useProjectSettingsActions.ts',
      'packages/studio-server-web/dashboard/useProjectPublicationReview.ts',
      'packages/studio-server-web/dashboard/projectSettingsForm.ts',
      'packages/studio-server-web/dashboard/publicationVersion.ts',
      'packages/studio-server-web/dashboard/WorkflowPublishedVersionHistoryModal.tsx',
      'packages/studio-server-web/dashboard/projectPublicationReview.ts',
      'packages/studio-server-web/playwright-observe/helpers/projectSettingsObserve.ts',
      'packages/studio-server-web/tests/project-publication-review.test.ts',
      'packages/studio-server-web/tests/publication-version.test.ts',
    ],
    languageOptions: {
      parserOptions: { project: ['./packages/studio-server-web/tsconfig.project-publication.json'] },
    },
  },

  // Scheduled Runs keeps request and form ownership in a focused hosted-web project.
  {
    files: [
      'packages/studio-server-web/dashboard/ScheduledRunsModal.tsx',
      'packages/studio-server-web/dashboard/useScheduledRunsController.ts',
      'packages/studio-server-web/dashboard/scheduledRunForm.ts',
      'packages/studio-server-web/dashboard/scheduledRunApi.ts',
      'packages/studio-server-web/playwright-observe/helpers/scheduledRunsFixture.ts',
      'packages/studio-server-web/tests/scheduled-run-api.test.ts',
      'packages/studio-server-web/tests/scheduled-run-form.test.ts',
    ],
    languageOptions: {
      parserOptions: { project: ['./packages/studio-server-web/tsconfig.scheduled-runs.json'] },
    },
  },

  // Configuration for ESLint config files
  {
    files: ['.eslint.config.mjs'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.node,
      },
    },
  },
];

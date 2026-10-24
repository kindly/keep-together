//  @ts-check

import { tanstackConfig } from '@tanstack/eslint-config'

export default [
  ...tanstackConfig,
  {
    rules: {
      'import/no-cycle': 'off',
      'import/order': 'off',
      'sort-imports': 'off',
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/require-await': 'off',
      'pnpm/json-enforce-catalog': 'off',
    },
  },
  {
    // Rule 6: domain functions are declared only through the scoped
    // constructors in convex/lib/tenancy.ts. Raw query/mutation/action may
    // be imported only by the control plane (convex/platform) and lib.
    files: ['convex/**/*.ts'],
    ignores: ['convex/platform/**', 'convex/lib/**', 'convex/_generated/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: './_generated/server',
              importNames: [
                'query',
                'mutation',
                'action',
                'internalQuery',
                'internalMutation',
                'internalAction',
              ],
              message:
                'Use tenantQuery/tenantMutation/tenantAction (or internalTenant*) from convex/lib/tenancy.ts. Raw constructors are allowed only under convex/platform/.',
            },
            {
              name: '../_generated/server',
              importNames: [
                'query',
                'mutation',
                'action',
                'internalQuery',
                'internalMutation',
                'internalAction',
              ],
              message:
                'Use tenantQuery/tenantMutation/tenantAction (or internalTenant*) from convex/lib/tenancy.ts. Raw constructors are allowed only under convex/platform/.',
            },
          ],
        },
      ],
    },
  },
  {
    ignores: [
      'eslint.config.js',
      'prettier.config.js',
      'convex/_generated/**',
      'src/routeTree.gen.ts',
      'dist/**',
      'dist-qc/**',
      'dist-qc-rs/**',
      // Copies of qc/flows/*.spec.ts made by qc-rs/playwright.config.ts.
      'qc-rs/.flows/**',
      'dist-preview*/**',
      'qc-report/**',
      'test-results/**',
    ],
  },
]

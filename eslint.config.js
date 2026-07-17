import eslint from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    files: ['packages/server/scripts/site-qa.mjs'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.vite/**',
      '**/*.pitolet.json',
      'packages/codegen/tests/golden/**',
      'deploy/**',
      'pitolet/**',
      'pitolet-data/**',
      'pitolet-export/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      globals: globals.nodeBuiltin,
    },
  },
  {
    files: [
      'packages/editor/src/**/*.{ts,tsx}',
      'packages/ui/src/**/*.{ts,tsx}',
      'apps/cloud/dashboard/src/**/*.{ts,tsx}',
    ],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
);

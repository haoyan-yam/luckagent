import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/**', 'node_modules/**', '*.js', '*.mjs', 'static/**'],
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-function': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: [
              '../../../src/*',
              '../../../../src/*',
            ],
            message: 'Server code must not import bridge (luckagent/src/) internals. Cross the boundary via HTTP /api/*.',
          },
        ],
      }],
    },
  },
);

import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['node_modules/**', 'coverage/**', 'dist/**', 'data/**', 'build/**', '.github/**', 'package-lock.json']
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.webextensions,
        chrome: 'readonly',
        browser: 'readonly',
        structuredClone: 'readonly'
      }
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },
  {
    files: ['public/**/*.mjs', 'e2e/**/*.mjs', 'eslint.config.mjs', 'test/**/*.mjs'],
    languageOptions: {
      sourceType: 'module'
    }
  }
];

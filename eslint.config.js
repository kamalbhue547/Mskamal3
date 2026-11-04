import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'coverage/'] },
  js.configs.recommended,
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    // Browser ES modules.
    files: ['assets/js/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser } },
  },
  {
    // Classic blocking script loaded in <head> (must not use import/export).
    files: ['assets/js/theme-init.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
  },
  {
    // Node tooling and tests.
    files: ['scripts/**/*.mjs', 'tests/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node } },
  },
];

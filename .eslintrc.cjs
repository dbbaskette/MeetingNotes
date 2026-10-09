module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
  ],
  settings: { react: { version: 'detect' } },
  rules: {
    'react/react-in-jsx-scope': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/consistent-type-imports': 'error',
  },
  overrides: [
    {
      // Tests and UI fixtures build partial fakes of large interfaces, where
      // `any` is the honest type. Product code keeps the rule.
      files: ['**/*.test.ts', '**/*.test.tsx', 'scripts/**'],
      rules: { '@typescript-eslint/no-explicit-any': 'off' },
    },
  ],
};

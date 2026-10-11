// @ts-check
import { defineConfig } from 'eslint-config-hyoban'

export default defineConfig(
  {
    formatting: false,
    ignores: (originals) => [
      ...originals,
      '.vscode/**',
      'dist/**',
      'docs/**',
      'agents.md',
      'readme.md',
    ],
    lessOpinionated: true,
    preferESM: false,
    react: true,
    stylistic: false,
    tailwindCSS: false,
  },
  {
    settings: {
      tailwindcss: {
        whitelist: ['center'],
      },
    },
    rules: {
      'unicorn/prefer-math-trunc': 'off',
      '@eslint-react/no-clone-element': 0,
      '@eslint-react/hooks-extra/no-direct-set-state-in-use-effect': 0,
      'antfu/no-top-level-await': 'off',
      'e18e/prefer-static-regex': 'off',
      'jsdoc/check-param-names': 'off',
      'jsdoc/require-returns-description': 'off',
      'prefer-exponentiation-operator': 'off',
      // NOTE: Disable this temporarily
      'react-compiler/react-compiler': 0,
      'react-hooks/exhaustive-deps': 'error',
      'react-naming-convention/ref-name': 'off',
      'react-naming-convention/use-state': 'off',
      'react/no-array-index-key': 'off',
      'react-refresh/only-export-components': 'off',
      'no-restricted-syntax': 0,
      'no-restricted-globals': [
        'error',
        {
          name: 'location',
          message:
            "Since you don't use the same router instance in electron and browser, you can't use the global location to get the route info. \n\n" +
            'Use `useLocation` from react-router to get the route info.',
        },
      ],
      'ts/no-explicit-any': 'off',
      'ts/no-use-before-define': 'off',
    },
  },
)

import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import diff from "eslint-plugin-diff";
import globals from "globals";
import tseslint from "typescript-eslint";

const strictLint = process.env.ULTRAFUZZ_STRICT_LINT === "1";
const browserFiles = ["packages/dashboard/frontend/{public,src}/**/*.{js,ts,tsx}"];
const typescriptFiles = ["packages/**/*.{ts,tsx}", "scripts/**/*.{ts,tsx}"];
const typeCheckedFiles = ["packages/*/src/**/*.ts", "packages/dashboard/frontend/src/**/*.{ts,tsx}"];
const sourceFiles = ["packages/**/*.{js,mjs,cjs,ts,tsx}", "scripts/**/*.{js,mjs,cjs,ts,tsx}"];
const strictConfigs = strictLint
  ? [
      ...tseslint.configs.strict.map((config) => ({
        ...config,
        files: typescriptFiles
      })),
      ...tseslint.configs.strictTypeChecked.map((config) => ({
        ...config,
        files: typeCheckedFiles
      })),
      {
        files: typeCheckedFiles,
        languageOptions: {
          parserOptions: {
            projectService: true,
            tsconfigRootDir: import.meta.dirname
          }
        }
      },
      {
        files: sourceFiles,
        rules: {
          complexity: ["error", 20],
          "max-depth": ["error", 4],
          "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }],
          "max-lines-per-function": ["error", { max: 80, skipBlankLines: true, skipComments: true }],
          "max-nested-callbacks": ["error", 4],
          "max-params": ["error", 5],
          "max-statements": ["error", 40],
          "no-console": "error",
          "no-warning-comments": ["error", { terms: ["todo", "fixme"], location: "anywhere" }]
        }
      },
      {
        files: [
          "**/{test,tests}/**/*.{js,mjs,cjs,ts,tsx}",
          "**/*.test.{js,mjs,cjs,ts,tsx}",
          "packages/runtime/src/templates/**/*.tsx"
        ],
        rules: {
          complexity: ["error", 25],
          "max-lines": ["error", { max: 1000, skipBlankLines: true, skipComments: true }],
          "max-lines-per-function": ["error", { max: 150, skipBlankLines: true, skipComments: true }],
          "max-params": ["error", 6],
          "max-statements": ["error", 80]
        }
      }
    ]
  : [];

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-test/**",
      "**/node_modules/**",
      ".smithers/**",
      ".worktrees/**",
      ".ultrafuzz/**",
      "packages/dashboard/frontend/.generated/**",
      "coverage/**"
    ]
  },
  {
    linterOptions: { reportUnusedDisableDirectives: "error" }
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...strictConfigs,
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    ignores: browserFiles,
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.node,
      sourceType: "module"
    }
  },
  {
    files: browserFiles,
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.browser,
      sourceType: "module"
    }
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "no-undef": "off",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          fixStyle: "inline-type-imports",
          prefer: "type-imports"
        }
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_"
        }
      ]
    }
  },
  eslintConfigPrettier,
  ...(strictLint ? diff.configs[process.env.CI ? "flat/ci" : "flat/diff"] : [])
);

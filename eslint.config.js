import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

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
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,ts}"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.node,
      sourceType: "module"
    }
  },
  {
    files: ["**/*.ts"],
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
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "ExpressionStatement > CallExpression[callee.name='validateSafeIdResult']",
          message: "validateSafeIdResult returns policy diagnostics; consume the result instead of discarding it."
        },
        {
          selector:
            "ExpressionStatement > CallExpression[callee.type='MemberExpression'][callee.property.name='validateSafeIdResult']",
          message: "validateSafeIdResult returns policy diagnostics; consume the result instead of discarding it."
        }
      ]
    }
  },
  eslintConfigPrettier
);

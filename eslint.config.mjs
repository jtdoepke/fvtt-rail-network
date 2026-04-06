import globals from "globals";
import pluginJs from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier/flat";

export default [
  {
    ignores: ["fvtt_source/", "node_modules/", "dist/"],
  },
  pluginJs.configs.recommended,
  eslintConfigPrettier,
  {
    rules: {
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        // Foundry VTT globals
        game: "readonly",
        canvas: "readonly",
        ui: "readonly",
        CONFIG: "readonly",
        CONST: "readonly",
        Hooks: "readonly",
        foundry: "readonly",
        fromUuid: "readonly",
        PIXI: "readonly",
        ChatMessage: "readonly",
        Sequence: "readonly",
        Macro: "readonly",
        CALENDARIA: "readonly",
      },
    },
  },
  {
    files: ["scripts/*.test.mjs"],
    languageOptions: {
      globals: globals.nodeBuiltin,
    },
  },
];

// Minimal flat config: plain browser scripts (no modules, no build step).
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "screenshots/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...globals.browser, AQ: "writable" },
    },
    rules: { "no-unused-vars": ["warn", { args: "none" }] },
  },
];

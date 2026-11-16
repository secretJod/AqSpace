/* eslint.config.js - lint rules for the API (ESLint flat config).

   What:  the recommended JavaScript rules, Node globals for the server code and tests,
          browser globals for the /dev pages in dev-ui/.
   Who uses it: `npm run lint`.
   Read next: .prettierrc.json (formatting is Prettier's job, not ESLint's). */
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "data/"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: globals.node },
    rules: {
      // Express tells middleware apart by argument count, so unused leading arguments are named `_req`, `_next`, ...
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }]
    }
  },
  {
    // The /dev pages are plain browser scripts (no modules, no build step).
    files: ["dev-ui/**/*.js"],
    languageOptions: { sourceType: "script", globals: globals.browser }
  }
];

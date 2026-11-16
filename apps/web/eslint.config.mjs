// ESLint flat config for the browser app.
// Every file under js/ is a classic <script> (no modules, no bundler) that shares the global `AQ` object,
// so files are linted as scripts with browser globals. Vendored libraries are linted by their authors, not us.
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "js/vendor/**"] },
  js.configs.recommended,
  {
    files: ["js/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...globals.browser, AQ: "writable", Chart: "readonly" }
    },
    rules: {
      "no-unused-vars": ["error", { args: "none" }]
    }
  }
];

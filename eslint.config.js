import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "src/generated/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node.js で動かすスクリプト用のグローバル
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
);

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "src/generated/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 「一部を取り除いた残り」を作る分割代入で、捨てる側を _ で始めた名前にできるようにする
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { varsIgnorePattern: "^_", argsIgnorePattern: "^_" }],
    },
  },
  {
    // Node.js で動かすスクリプト用のグローバル
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", Buffer: "readonly" } },
  },
);

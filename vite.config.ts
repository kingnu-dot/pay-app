import { defineConfig } from "vitest/config";
import preact from "@preact/preset-vite";

// GitHub Pages のプロジェクトサイト（/pay-app/）で配信するため base を固定する
export default defineConfig({
  base: "/pay-app/",
  plugins: [preact()],
  build: {
    target: "es2022",
    sourcemap: false,
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});

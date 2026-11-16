import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import preact from "@preact/preset-vite";

// 外部スクリプトを読み込まず、通信先をルール取得用の API だけに絞る。
// 開発サーバはインラインのスクリプトとスタイルを使うので、本番のビルドにだけ付ける
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https://api.github.com",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

function cspPlugin(): Plugin {
  return {
    name: "inject-csp",
    apply: "build",
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: "meta",
            attrs: { "http-equiv": "Content-Security-Policy", content: CSP },
            injectTo: "head-prepend",
          },
        ],
      };
    },
  };
}

// GitHub Pages のプロジェクトサイト（/pay-app/）で配信するため base を固定する
export default defineConfig({
  base: "/pay-app/",
  plugins: [preact(), cspPlugin()],
  build: {
    target: "es2022",
    sourcemap: false,
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});

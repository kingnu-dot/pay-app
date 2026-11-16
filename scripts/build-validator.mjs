// JSON Schema から検証関数を事前生成する（実行時に Ajv 本体を読み込まないため）
// 出力：src/generated/validate-rules.js と型定義（.d.ts）

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Module from "ajv/dist/2020.js";
import standaloneModule from "ajv/dist/standalone/index.js";

const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;
const standaloneCode = standaloneModule.default ?? standaloneModule;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(join(root, "schema", "rules.schema.json"), "utf8"));

const ajv = new Ajv2020({ allErrors: true, strict: true, code: { source: true, esm: true } });
const validate = ajv.compile(schema);
const code = standaloneCode(ajv, validate);

// 生成コードが Ajv の実行時モジュールに依存すると、アプリに Ajv が混入する。依存があれば失敗させる
if (/\brequire\(|from\s+["']ajv/.test(code)) {
  console.error("生成した検証関数が Ajv の実行時モジュールに依存しています。Schema のキーワードを見直してください。");
  process.exit(1);
}

const outDir = join(root, "src", "generated");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "validate-rules.js"), `// 自動生成（scripts/build-validator.mjs）。直接編集しない\n${code}\n`);
writeFileSync(
  join(outDir, "validate-rules.d.ts"),
  `// 自動生成（scripts/build-validator.mjs）。直接編集しない
export interface SchemaError {
  instancePath: string;
  keyword: string;
  message?: string;
  params: Record<string, unknown>;
}
declare const validate: {
  (data: unknown): boolean;
  errors?: SchemaError[] | null;
};
export default validate;
`,
);
console.log(`検証関数を生成しました: src/generated/validate-rules.js (${code.length} 文字)`);

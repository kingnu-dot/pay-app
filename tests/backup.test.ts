import { describe, expect, it } from "vitest";
import { backupFileName, buildBackup, isBackupDue, parseBackup } from "../src/backup/backup";
import { defaultSettings } from "../src/settings/settings";
import type { SpendEntry } from "../src/storage/db";

const NOW = new Date("2026-01-10T03:00:00.000Z");
const settings = { ...defaultSettings(), favorite_store_ids: ["store_s"], disabled_method_ids: ["qr_from_bank"] };
const spend: SpendEntry[] = [
  { id: 1, date: "2025-12-01", amount_yen: 1200, kind: "payment", method_id: "card_a_gpay", annual_card_id: "card_a", note: "店舗S／カードA", created_at: "2025-12-01T03:00:00.000Z" },
  { id: 2, date: "2026-01-05", amount_yen: -200, kind: "adjustment", method_id: null, annual_card_id: "card_a", created_at: "2026-01-05T03:00:00.000Z" },
  { id: 7, date: "2025-11-20", amount_yen: 800, kind: "payment", method_id: "card_c_quicpay", annual_card_id: null, created_at: "2025-11-20T03:00:00.000Z" },
];
const exported = () => JSON.stringify(buildBackup({ settings, spend, now: NOW }));
const edited = (change: (data: Record<string, unknown>) => void): string => {
  const data = JSON.parse(exported()) as Record<string, unknown>;
  change(data);
  return JSON.stringify(data);
};

describe("buildBackup", () => {
  const backup = buildBackup({ settings, spend, now: NOW });

  it("個人設定と利用記録を入れ、端末内の通し番号は含めない", () => {
    expect(backup).toMatchObject({ format: "pay-app-backup", version: 1, exported_at: "2026-01-10T03:00:00.000Z", settings });
    expect(backup.spend).toHaveLength(3);
    expect(backup.spend.every((e) => !("id" in e))).toBe(true);
  });

  it("トークンや取得先を入れる項目がない", () => {
    expect(Object.keys(backup).sort()).toEqual(["coupons", "exported_at", "format", "settings", "spend", "version"]);
  });

  it("ファイル名に日付を入れる", () => {
    expect(backupFileName("2026-01-10")).toBe("pay-app-backup-2026-01-10.json");
    expect(backupFileName("2026-01-10", "txt")).toBe("pay-app-backup-2026-01-10.txt");
  });
});

describe("parseBackup", () => {
  it("書き出したものを読み戻すと同じ内容になり、要約が付く", () => {
    const parsed = parseBackup(exported());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.backup).toEqual(buildBackup({ settings, spend, now: NOW }));
    expect(parsed.summary).toEqual({
      exported_at: "2026-01-10T03:00:00.000Z",
      spend_count: 3,
      first_date: "2025-11-20",
      last_date: "2026-01-05",
      total_yen: 1800,
      coupon_count: 0,
      favorite_count: 1,
      custom_store_count: 0,
      disabled_method_count: 1,
    });
  });

  it("記録が空でも読める", () => {
    const parsed = parseBackup(JSON.stringify(buildBackup({ settings, spend: [], now: NOW })));
    expect(parsed).toMatchObject({ ok: true, summary: { spend_count: 0, first_date: null, last_date: null, total_yen: 0 } });
  });

  it("JSON でないもの、別のファイル、未対応の版は読み込まない", () => {
    expect(parseBackup("{ not json")).toMatchObject({ ok: false });
    expect(parseBackup(JSON.stringify({ schema_version: 1, points: [] }))).toMatchObject({ ok: false });
    expect(parseBackup(edited((d) => { d.version = 2; }))).toMatchObject({ ok: false });
    expect(parseBackup(edited((d) => { d.exported_at = "いつか"; }))).toMatchObject({ ok: false });
    expect(parseBackup(edited((d) => { d.spend = "なし"; }))).toMatchObject({ ok: false });
  });

  it("読めない記録が1件でもあれば全体を読み込まず、何件目かを示す", () => {
    const bad = (change: (entry: Record<string, unknown>) => void) =>
      parseBackup(edited((d) => { change((d.spend as Array<Record<string, unknown>>)[1]!); }));
    expect(bad((e) => { e.date = "2026-02-31"; })).toEqual({ ok: false, message: "利用記録の 2 件目が読めません。" });
    expect(bad((e) => { e.amount_yen = 12.5; })).toMatchObject({ ok: false });
    expect(bad((e) => { e.amount_yen = 1e12; })).toMatchObject({ ok: false });
    expect(bad((e) => { e.kind = "refund"; })).toMatchObject({ ok: false });
    expect(bad((e) => { e.annual_card_id = 5; })).toMatchObject({ ok: false });
    expect(bad((e) => { delete e.created_at; })).toMatchObject({ ok: false });
  });

  it("個人設定の壊れた項目は既定値にして読み込む", () => {
    const parsed = parseBackup(edited((d) => { d.settings = { annual_threshold_yen: "多め", favorite_store_ids: ["store_t"] }; }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.backup.settings).toEqual({ ...defaultSettings(), favorite_store_ids: ["store_t"] });
  });
});

describe("isBackupDue：月1回の催促", () => {
  it("記録がまだ無ければ促さない", () => {
    expect(isBackupDue(null, "2026-01-10", 0)).toBe(false);
  });

  it("一度も書き出していなければ促す", () => {
    expect(isBackupDue(null, "2026-01-10", 1)).toBe(true);
  });

  it("前回から 29 日は促さず、30 日で促す", () => {
    expect(isBackupDue("2025-12-12", "2026-01-10", 5)).toBe(false);
    expect(isBackupDue("2025-12-11", "2026-01-10", 5)).toBe(true);
  });
});

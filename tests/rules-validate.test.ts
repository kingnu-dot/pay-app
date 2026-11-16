import { describe, expect, it } from "vitest";
import { parseRules } from "../src/rules/validate";
import sample from "./fixtures/sample-rules.json";

/** サンプルの深いコピーを作り、変更を加えてから返す */
function mutate(change: (rules: typeof sample) => void): unknown {
  const copy = structuredClone(sample);
  change(copy);
  return copy;
}

/** 不合格になることを確認し、エラー一覧を返す */
function errorsOf(data: unknown): string[] {
  const result = parseRules(data);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors;
}

describe("parseRules：合格する場合", () => {
  it("架空のサンプルルールが検証に通る", () => {
    const result = parseRules(sample);
    expect(result).toMatchObject({ ok: true });
  });
});

describe("parseRules：Schema（構造）の違反", () => {
  it("オブジェクトでないものは不合格", () => {
    expect(errorsOf(null).length).toBeGreaterThan(0);
    expect(errorsOf("rules").length).toBeGreaterThan(0);
  });

  it("必須のメタ情報（source_url）が無いと不合格で、箇所が分かる", () => {
    const errors = errorsOf(
      mutate((r) => {
        delete (r.cards[0]!.rewards[0]!.meta as Partial<(typeof r.cards)[0]["rewards"][0]["meta"]>).source_url;
      }),
    );
    expect(errors.some((e) => e.startsWith("/cards/0/rewards/0/meta"))).toBe(true);
  });

  it("付与量が整数でないと不合格", () => {
    const errors = errorsOf(mutate((r) => { r.cards[0]!.rewards[0]!.points_per_unit = 0.5; }));
    expect(errors.some((e) => e.includes("/cards/0/rewards/0/points_per_unit"))).toBe(true);
  });

  it("日付の書式が違うと不合格", () => {
    const errors = errorsOf(mutate((r) => { r.updated_at = "2026/01/10"; }));
    expect(errors.some((e) => e.includes("/updated_at"))).toBe(true);
  });

  it("未知の払い方は不合格", () => {
    const errors = errorsOf(mutate((r) => { r.methods[0]!.pay_type = "cash"; }));
    expect(errors.some((e) => e.includes("/methods/0/pay_type"))).toBe(true);
  });

  it("定義にない項目があると不合格", () => {
    const errors = errorsOf(mutate((r) => { (r.stores[0] as Record<string, unknown>).rate = 5; }));
    expect(errors.some((e) => e.includes("/stores/0"))).toBe(true);
  });

  it("https 以外の出典 URL は不合格", () => {
    const errors = errorsOf(mutate((r) => { r.store_groups[0]!.meta.source_url = "http://example.com/x"; }));
    expect(errors.some((e) => e.includes("/store_groups/0/meta/source_url"))).toBe(true);
  });
});

describe("parseRules：整合性の違反", () => {
  it("id の重複は不合格", () => {
    const errors = errorsOf(mutate((r) => { r.stores[1]!.id = r.stores[0]!.id; }));
    expect(errors.some((e) => e.includes("重複") && e.includes("store_s"))).toBe(true);
  });

  it("存在しないポイントを参照する還元ルールは不合格", () => {
    const errors = errorsOf(mutate((r) => { r.cards[0]!.rewards[0]!.point_id = "point_none"; }));
    expect(errors.some((e) => e.includes("point_none"))).toBe(true);
  });

  it("存在しないカードを参照する支払い手段は不合格", () => {
    const errors = errorsOf(mutate((r) => { r.methods[0]!.card_id = "card_none"; }));
    expect(errors.some((e) => e.includes("card_none"))).toBe(true);
  });

  it("存在しない店舗を含む店舗グループは不合格", () => {
    const errors = errorsOf(mutate((r) => { r.store_groups[0]!.store_ids.push("store_none"); }));
    expect(errors.some((e) => e.includes("store_none"))).toBe(true);
  });

  it("有効期間の開始が終了より後だと不合格", () => {
    const errors = errorsOf(
      mutate((r) => {
        const meta = r.cards[2]!.rewards[1]!.meta;
        meta.valid_from = "2025-07-01";
        meta.valid_to = "2025-06-30";
      }),
    );
    expect(errors.some((e) => e.includes("valid_from"))).toBe(true);
  });
});

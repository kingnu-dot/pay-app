import { describe, expect, it } from "vitest";
import { isActive, rankMethods, type Candidate, type RankInput } from "../src/engine/recommend";
import { parseRules } from "../src/rules/validate";
import type { Rules } from "../src/rules/types";
import sample from "./fixtures/sample-rules.json";

const parsed = parseRules(sample);
if (!parsed.ok) throw new Error(`サンプルルールが不正です: ${parsed.errors.join(" / ")}`);
const rules: Rules = parsed.rules;

/** 既定の判定日（どのルールの特定日にも当たらない日） */
const DATE = "2026-01-10";

function rank(overrides: Partial<RankInput>): Candidate[] {
  return rankMethods({ rules, store_id: null, amount_yen: 1000, date: DATE, ...overrides }).candidates;
}

/** [手段の id, 円換算額（1/1000 円）] の一覧にする */
function totals(candidates: Candidate[]): Array<[string, number | null]> {
  return candidates.map((c) => [c.method.id, c.total_milliyen]);
}

function find(candidates: Candidate[], method_id: string): Candidate {
  const c = candidates.find((x) => x.method.id === method_id);
  if (!c) throw new Error(`候補にありません: ${method_id}`);
  return c;
}

describe("rankMethods：加算の対象店（店舗S、1,000 円）", () => {
  const candidates = rank({ store_id: "store_s" });

  it("還元の大きい順に並ぶ（同額はルールに書かれた順）", () => {
    expect(totals(candidates)).toEqual([
      ["card_a_gpay", 50_000], // 基本の期待値 10pt + 加算 40pt = 50 円相当
      ["card_c_quicpay", 15_000], // 1,000 × 15/1000 = 15pt
      ["card_a_insert", 10_000], // 基本のみ
      ["card_b_insert", 10_000], // 四捨五入(1000/200) = 5pt × 2 円
      ["transit_from_card_b", 8_000], // チャージ 8pt
      ["qr_from_bank", 5_000], // 利用時 5pt
    ]);
  });

  it("内訳に、月間合算は期待値、1回ごとは実付与量が入る", () => {
    const top = find(candidates, "card_a_gpay");
    expect(top.components.map((c) => [c.rule_id, c.basis, c.points, c.value_milliyen])).toEqual([
      ["card_a_base", "expected", null, 10_000],
      ["card_a_touch_bonus", "actual", 40, 40_000],
    ]);
    expect(top.rate_ppm).toBe(50_000); // 5%
  });

  it("チャージ型は、チャージ時の還元を期待値として計上する", () => {
    const transit = find(candidates, "transit_from_card_b");
    expect(transit.components.map((c) => [c.source, c.basis, c.unverified])).toEqual([["charge", "expected", true]]);
  });

  it("通販用の手段は店頭の候補に入らない", () => {
    expect(candidates.some((c) => c.method.id === "card_c_online")).toBe(false);
  });
});

describe("rankMethods：適用条件", () => {
  it("例外に登録した店舗（店舗U）では加算が付かない", () => {
    const candidates = rank({ store_id: "store_u" });
    expect(find(candidates, "card_a_gpay").total_milliyen).toBe(10_000);
    expect(candidates[0]?.method.id).toBe("card_c_quicpay");
  });

  it("払い方が違うと加算が付かない（差し込みは基本のみ）", () => {
    const insert = find(rank({ store_id: "store_s" }), "card_a_insert");
    expect(insert.components.map((c) => c.rule_id)).toEqual(["card_a_base"]);
  });

  it("未登録の店は一般加盟店として、基本の還元だけで比較する", () => {
    const result = rankMethods({ rules, store_id: "store_unknown", amount_yen: 1000, date: DATE });
    expect(result.store).toBeNull();
    expect(result.candidates[0]?.method.id).toBe("card_c_quicpay");
    expect(find(result.candidates, "card_a_gpay").total_milliyen).toBe(10_000);
  });

  it("開始日より前は適用されず、開始日から適用される", () => {
    expect(find(rank({ store_id: "store_s", date: "2025-03-31" }), "card_a_gpay").total_milliyen).toBe(10_000);
    expect(find(rank({ store_id: "store_s", date: "2025-04-01" }), "card_a_gpay").total_milliyen).toBe(50_000);
  });

  it("終了日までは適用され、翌日からは適用されない", () => {
    // カードC：基本 15pt + 期間限定の上乗せ 50pt
    expect(find(rank({ date: "2025-06-30" }), "card_c_quicpay").total_milliyen).toBe(65_000);
    expect(find(rank({ date: "2025-07-01" }), "card_c_quicpay").total_milliyen).toBe(15_000);
  });

  it("1回の利用以外の上限は、計算に反映せず注記として返す", () => {
    const campaign = find(rank({ date: "2025-06-15" }), "card_c_quicpay").components[1];
    expect(campaign?.cap_note).toEqual({ amount: 500, unit: "point", period: "month" });
  });
});

describe("rankMethods：基本の置き換えと倍率（店舗T）", () => {
  it("提携店では基本を置き換え、四捨五入の後に 3 倍する", () => {
    const candidates = rank({ store_id: "store_t" });
    const b = find(candidates, "card_b_insert");
    // 四捨五入(1000/200) = 5 → × 3 = 15pt × 2 円 = 30 円相当
    expect(b.components.map((c) => [c.rule_id, c.points])).toEqual([["card_b_partner", 15]]);
    expect(b.total_milliyen).toBe(30_000);
    expect(candidates[0]?.method.id).toBe("card_b_insert");
  });

  it("300 円：四捨五入(1.5) = 2 → × 3 = 6pt（3 倍してから四捨五入した 5pt にはならない）", () => {
    const b = find(rank({ store_id: "store_t", amount_yen: 300 }), "card_b_insert");
    expect(b.components[0]?.points).toBe(6);
    expect(b.total_milliyen).toBe(12_000);
  });
});

describe("rankMethods：店舗で使えない手段", () => {
  it("店舗が受け付けない払い方は候補から外す", () => {
    expect(rank({ store_id: "store_t" }).some((c) => c.method.pay_type === "qr_pay")).toBe(false);
  });

  it("店舗ごとに使えないと登録した手段は候補から外す", () => {
    expect(rank({ store_id: "store_v" }).some((c) => c.method.id === "card_c_quicpay")).toBe(false);
  });

  it("個人設定で無効にした手段は候補から外す", () => {
    const candidates = rank({ store_id: "store_s", disabled_method_ids: ["card_a_gpay"] });
    expect(candidates[0]?.method.id).toBe("card_c_quicpay");
  });

  it("通販の店舗では、通販用の手段だけが候補になる", () => {
    expect(totals(rank({ store_id: "store_w" }))).toEqual([["card_c_online", 15_000]]);
  });
});

describe("rankMethods：金額の扱い", () => {
  it("金額未入力のときは、名目の還元率で比較する", () => {
    const candidates = rank({ store_id: "store_s", amount_yen: null });
    expect(candidates.map((c) => [c.method.id, c.total_milliyen, c.rate_ppm])).toEqual([
      ["card_a_gpay", null, 50_000],
      ["card_c_quicpay", null, 15_000],
      ["card_a_insert", null, 10_000],
      ["card_b_insert", null, 10_000],
      ["transit_from_card_b", null, 8_000],
      ["qr_from_bank", null, 5_000],
    ]);
    expect(candidates[0]?.components.every((c) => c.basis === "rate")).toBe(true);
  });

  it("少額では端数処理で順位が入れ替わる（99 円）", () => {
    const candidates = rank({ store_id: "store_s", amount_yen: 99 });
    expect(totals(candidates).slice(0, 2)).toEqual([
      ["card_c_quicpay", 1_485], // 期待値 99 × 15/1000 = 1.485 円
      ["card_a_gpay", 990], // 基本の期待値 0.99 円、加算は 100 円未満で 0
    ]);
    // 1回ごとに四捨五入するカードB は 99 円で 0 ポイント
    expect(find(candidates, "card_b_insert").total_milliyen).toBe(0);
  });

  it("四捨五入の境目：カードB は 100 円で 1 ポイント付く", () => {
    expect(find(rank({ amount_yen: 100 }), "card_b_insert").total_milliyen).toBe(2_000);
  });

  it("金額 0 円でも例外にならず、還元率で並ぶ", () => {
    const candidates = rank({ store_id: "store_s", amount_yen: 0 });
    expect(candidates[0]?.method.id).toBe("card_a_gpay");
    expect(candidates[0]?.total_milliyen).toBe(0);
  });

  it("負の金額や整数でない金額は例外にする", () => {
    expect(() => rank({ amount_yen: -1 })).toThrow(RangeError);
    expect(() => rank({ amount_yen: 10.5 })).toThrow(RangeError);
  });

  it("日付の書式が違うと例外にする", () => {
    expect(() => rank({ date: "2026/01/10" })).toThrow(RangeError);
  });
});

describe("isActive：有効期間", () => {
  it("両端を含み、null は制限なし", () => {
    const meta = { valid_from: "2025-06-01", valid_to: "2025-06-30" };
    expect(isActive(meta, "2025-05-31")).toBe(false);
    expect(isActive(meta, "2025-06-01")).toBe(true);
    expect(isActive(meta, "2025-06-30")).toBe(true);
    expect(isActive(meta, "2025-07-01")).toBe(false);
    expect(isActive({ valid_from: null, valid_to: null }, "2025-07-01")).toBe(true);
  });
});

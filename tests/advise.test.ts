import { describe, expect, it } from "vitest";
import { recommend, ruleAlerts, type AdviseInput, type Recommendation } from "../src/engine/advise";
import { parseRules } from "../src/rules/validate";
import type { Rules } from "../src/rules/types";
import sample from "./fixtures/sample-rules.json";

const parsed = parseRules(sample);
if (!parsed.ok) throw new Error(`サンプルルールが不正です: ${parsed.errors.join(" / ")}`);
const rules: Rules = parsed.rules;

// 2026-01-10 時点のカードA（目標 500,000 円、開始 4/1）の日割りペースは 389,041 円
const DATE = "2026-01-10";
const BEHIND = { card_a: 300_000 };
const ON_PACE = { card_a: 400_000 };

function advise(overrides: Partial<AdviseInput>): Recommendation {
  return recommend({
    rules,
    store_id: null,
    amount_yen: 1000,
    date: DATE,
    annual_spent_yen: ON_PACE,
    annual_threshold_yen: 5,
    ...overrides,
  });
}

function order(r: Recommendation): string[] {
  return r.advices.map((a) => a.candidate.method.id);
}

describe("recommend：年間目標による優先（未登録の店。1位 カードC 15 円、カードA 10 円）", () => {
  it("ペース内なら順位を変えない", () => {
    const r = advise({ annual_spent_yen: ON_PACE });
    expect(order(r)[0]).toBe("card_c_quicpay");
    expect(r.promotion).toBeNull();
    expect(r.pace_alert_card_ids).toEqual([]);
  });

  it("ペース遅れで、差が閾値ちょうど（5 円）なら目標のあるカードを1位にする", () => {
    const r = advise({ annual_spent_yen: BEHIND });
    expect(order(r).slice(0, 2)).toEqual(["card_a_gpay", "card_c_quicpay"]);
    expect(r.promotion).toEqual({ method_id: "card_a_gpay", card_id: "card_a", diff_milliyen: 5_000 });
  });

  it("ペース遅れでも、差が閾値を超えると順位を変えず、知らせるだけにする", () => {
    // 1,001 円：カードC 15.015 円、カードA 10.010 円 → 差 5.005 円
    const r = advise({ annual_spent_yen: BEHIND, amount_yen: 1001 });
    expect(order(r)[0]).toBe("card_c_quicpay");
    expect(r.promotion).toBeNull();
    expect(r.pace_alert_card_ids).toEqual(["card_a"]);
  });

  it("閾値を 4 円にすると、差 5 円では入れ替えない", () => {
    const r = advise({ annual_spent_yen: BEHIND, annual_threshold_yen: 4 });
    expect(r.promotion).toBeNull();
  });

  it("金額未入力のときは入れ替えず、知らせるだけにする", () => {
    const r = advise({ annual_spent_yen: BEHIND, amount_yen: null });
    expect(order(r)[0]).toBe("card_c_quicpay");
    expect(r.promotion).toBeNull();
    expect(r.pace_alert_card_ids).toEqual(["card_a"]);
  });

  it("もともと1位なら、入れ替えも知らせも行わない", () => {
    const r = advise({ annual_spent_yen: BEHIND, store_id: "store_s" });
    expect(order(r)[0]).toBe("card_a_gpay");
    expect(r.promotion).toBeNull();
    expect(r.pace_alert_card_ids).toEqual([]);
  });

  it("累計の記録がないカードは 0 円として扱う（ペース遅れになる）", () => {
    const r = advise({ annual_spent_yen: {} });
    expect(r.annual[0]?.status).toMatchObject({ spent_yen: 0, behind: true });
  });

  it("達成済みなら優先しない", () => {
    const r = advise({ annual_spent_yen: { card_a: 500_000 } });
    expect(r.promotion).toBeNull();
    expect(r.annual[0]?.status.achieved).toBe(true);
  });

  it("期間が切り替わった初日は、累計 0 でも遅れにならない", () => {
    const r = advise({ annual_spent_yen: { card_a: 0 }, date: "2026-04-01" });
    expect(r.annual[0]?.status.period).toEqual({ start: "2026-04-01", end: "2027-03-31" });
    expect(r.promotion).toBeNull();
  });

  it("無効にした手段は優先の対象にならない", () => {
    const r = advise({ annual_spent_yen: BEHIND, disabled_method_ids: ["card_a_gpay"] });
    // 同じカードの別の払い方（差し込み、10 円）が代わりに優先される
    expect(r.promotion?.method_id).toBe("card_a_insert");
  });
});

describe("recommend：注意事項", () => {
  const notices = (r: Recommendation, method_id: string) =>
    r.advices.find((a) => a.candidate.method.id === method_id)?.notices ?? [];

  it("金額の条件が付いた注意は、超えたときだけ出る（8,000 円 / 8,001 円）", () => {
    const at = (amount_yen: number | null) =>
      notices(advise({ store_id: "store_s", amount_yen }), "card_a_gpay").filter((n) => n.kind === "method_warning");
    expect(at(8000)).toEqual([]);
    expect(at(8001)).toHaveLength(1);
    expect(at(null)).toEqual([]);
  });

  it("未検証のルールと、確認から 90 日以上たったルールに印が付く", () => {
    const kinds = notices(advise({ store_id: "store_s" }), "transit_from_card_b").map((n) => n.kind);
    expect(kinds).toEqual(["unverified", "stale"]);
  });

  it("要再確認の境目：確認日から 89 日は付かず、90 日で付く", () => {
    // card_b_charge の last_verified は 2025-09-01
    const stale = (date: string) =>
      notices(advise({ date }), "transit_from_card_b").some((n) => n.kind === "stale");
    expect(stale("2025-11-29")).toBe(false);
    expect(stale("2025-11-30")).toBe(true);
  });

  it("1回の利用以外の上限があるルールに印が付く", () => {
    const caps = notices(advise({ date: "2025-06-15" }), "card_c_quicpay").filter((n) => n.kind === "cap");
    expect(caps).toHaveLength(1);
  });
});

describe("recommend：ポイント利用の案内（店舗V、毎月 15 日、1 ポイント 1.3 円、1会計 3,000 ポイントまで）", () => {
  const at = (date: string, amount_yen: number | null = 1000) =>
    advise({ store_id: "store_v", date, amount_yen }).redemptions;

  it("日付の境目：14 日と 16 日は出ず、15 日だけ出る", () => {
    expect(at("2026-01-14")).toEqual([]);
    expect(at("2026-01-15")).toHaveLength(1);
    expect(at("2026-01-16")).toEqual([]);
  });

  it("必要なポイントは切り上げで計算する（1,000 円 → 770 ポイント）", () => {
    expect(at("2026-01-15", 1000)[0]).toMatchObject({ use_points: 770, covered_yen: 1000, remainder_yen: 0 });
  });

  it("上限ちょうど：3,900 円は 3,000 ポイントで払いきれる", () => {
    expect(at("2026-01-15", 3900)[0]).toMatchObject({ use_points: 3000, covered_yen: 3900, remainder_yen: 0 });
  });

  it("上限超過：3,901 円は 3,000 ポイントまでで、残り 1 円を他の手段で払う", () => {
    expect(at("2026-01-15", 3901)[0]).toMatchObject({ use_points: 3000, covered_yen: 3900, remainder_yen: 1 });
  });

  it("金額未入力のときは、上限だけを返す", () => {
    expect(at("2026-01-15", null)[0]).toMatchObject({ cap_points: 3000, use_points: null, remainder_yen: null });
  });

  it("対象外の店舗や未登録の店では出ない", () => {
    expect(advise({ store_id: "store_s", date: "2026-01-15" }).redemptions).toEqual([]);
    expect(advise({ store_id: null, date: "2026-01-15" }).redemptions).toEqual([]);
  });
});

describe("recommend：提示するポイントカード", () => {
  it("店舗に登録されたポイントカードを返す", () => {
    expect(advise({ store_id: "store_s" }).loyalty.map((l) => l.label)).toEqual(["ポイントZのカード"]);
    expect(advise({ store_id: "store_t" }).loyalty).toEqual([]);
  });
});

describe("ruleAlerts：ホーム画面の警告", () => {
  const expiring = (date: string) =>
    ruleAlerts(rules, date).filter((a) => a.kind === "expiring").map((a) => [a.where, a.days]);

  it("まもなく終了の境目：終了の 31 日前は出ず、30 日前から出る", () => {
    // card_c_campaign の valid_to は 2025-06-30（valid_from は 2025-06-01）
    expect(expiring("2025-06-01")).toEqual([["cards/card_c/rewards/card_c_campaign", 29]]);
    expect(expiring("2025-06-30")).toEqual([["cards/card_c/rewards/card_c_campaign", 0]]);
  });

  it("期限切れのルールや、まだ始まっていないルールは対象外", () => {
    expect(expiring("2025-07-01")).toEqual([]);
    expect(expiring("2025-05-31")).toEqual([]);
  });

  it("確認から 90 日以上たったルールを要再確認として返す", () => {
    const stale = ruleAlerts(rules, DATE).filter((a) => a.kind === "stale").map((a) => a.where);
    expect(stale).toEqual(["cards/card_b/rewards/card_b_charge"]);
  });
});

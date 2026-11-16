// レビューで見つかった抜けを確認するテスト。サンプルルールを一部書き換えた変種を使う

import { describe, expect, it } from "vitest";
import { recommend, ruleAlerts, type AdviseInput } from "../src/engine/advise";
import { toJstDate } from "../src/engine/dates";
import { MAX_AMOUNT_YEN, rankMethods } from "../src/engine/recommend";
import { parseRules } from "../src/rules/validate";
import type { Rules } from "../src/rules/types";
import sample from "./fixtures/sample-rules.json";

const DATE = "2026-01-10";

/** サンプルを書き換えた変種を作る（検証に通ることも確認する） */
function variant(change: (rules: Rules) => void): Rules {
  const copy = structuredClone(sample) as unknown as Rules;
  change(copy);
  const parsed = parseRules(copy);
  if (!parsed.ok) throw new Error(`変種のルールが不正です: ${parsed.errors.join(" / ")}`);
  return parsed.rules;
}

/** サンプルを書き換えたものが不合格になることを確認し、エラー一覧を返す */
function invalid(change: (rules: Rules) => void): string[] {
  const copy = structuredClone(sample) as unknown as Rules;
  change(copy);
  const parsed = parseRules(copy);
  expect(parsed.ok).toBe(false);
  return parsed.ok ? [] : parsed.errors;
}

const base = variant(() => {});
const rewardOf = (rules: Rules, card_id: string, rule_id: string) => {
  const rule = rules.cards.find((c) => c.id === card_id)?.rewards.find((r) => r.id === rule_id);
  if (!rule) throw new Error(`ルールがありません: ${rule_id}`);
  return rule;
};
const totalOf = (rules: Rules, method_id: string, input: Partial<AdviseInput> = {}): number | null | undefined =>
  rankMethods({ rules, store_id: "store_s", amount_yen: 1000, date: DATE, ...input }).candidates.find(
    (c) => c.method.id === method_id,
  )?.total_milliyen;

describe("還元ルールの日付条件（毎月 15 日だけ加算）", () => {
  const rules = variant((r) => {
    rewardOf(r, "card_a", "card_a_touch_bonus").applies.days_of_month = [15];
  });

  it("日付の境目：14 日と 16 日は基本のみ、15 日だけ加算が付く", () => {
    expect(totalOf(rules, "card_a_gpay", { date: "2026-01-14" })).toBe(10_000);
    expect(totalOf(rules, "card_a_gpay", { date: "2026-01-15" })).toBe(50_000);
    expect(totalOf(rules, "card_a_gpay", { date: "2026-01-16" })).toBe(10_000);
  });

  it("時刻から変換した Asia/Tokyo の日付で判定する（UTC 14 日 15:00 = 日本時間 15 日 0:00）", () => {
    expect(totalOf(rules, "card_a_gpay", { date: toJstDate(new Date("2026-01-14T14:59:59Z")) })).toBe(10_000);
    expect(totalOf(rules, "card_a_gpay", { date: toJstDate(new Date("2026-01-14T15:00:00Z")) })).toBe(50_000);
  });
});

describe("還元ルールの 1回あたりの上限", () => {
  it("ポイントの上限：ちょうどは満額、超過分は付かない", () => {
    const rules = variant((r) => {
      rewardOf(r, "card_a", "card_a_touch_bonus").meta.cap = { amount: 40, unit: "point", period: "txn" };
    });
    expect(totalOf(rules, "card_a_gpay", { amount_yen: 1000 })).toBe(50_000); // 基本 10 + 加算 40（上限ちょうど）
    expect(totalOf(rules, "card_a_gpay", { amount_yen: 1100 })).toBe(51_000); // 基本 11 + 加算 44 → 40 に切り詰め
  });

  it("対象金額の上限：超えた分には加算が付かない", () => {
    const rules = variant((r) => {
      rewardOf(r, "card_a", "card_a_touch_bonus").meta.cap = { amount: 1000, unit: "yen", period: "txn" };
    });
    expect(totalOf(rules, "card_a_gpay", { amount_yen: 1000 })).toBe(50_000);
    expect(totalOf(rules, "card_a_gpay", { amount_yen: 2000 })).toBe(60_000); // 基本 20 + 加算は 1,000 円分の 40
  });

  it("上限のあるルールには、1回あたりの上限でも注意が付く", () => {
    const rules = variant((r) => {
      rewardOf(r, "card_a", "card_a_touch_bonus").meta.cap = { amount: 40, unit: "point", period: "txn" };
    });
    const top = recommend({ rules, store_id: "store_s", amount_yen: 1100, date: DATE }).advices[0];
    expect(top?.notices.filter((n) => n.kind === "cap")).toHaveLength(1);
  });
});

describe("店舗グループの有効期間", () => {
  it("グループの有効期間が切れると、そのグループを条件にしたルールは適用されない", () => {
    const rules = variant((r) => {
      const group = r.store_groups.find((g) => g.id === "group_touch_bonus");
      if (group) group.meta.valid_to = "2025-12-31";
    });
    expect(totalOf(rules, "card_a_gpay", { date: "2025-12-31" })).toBe(50_000);
    expect(totalOf(rules, "card_a_gpay", { date: "2026-01-01" })).toBe(10_000);
  });
});

describe("まもなく終了の境目（終了日 2026-02-09 のルール）", () => {
  const rules = variant((r) => {
    rewardOf(r, "card_a", "card_a_base").meta.valid_to = "2026-02-09";
  });
  const expiring = (date: string) =>
    ruleAlerts(rules, date).filter((a) => a.kind === "expiring").map((a) => a.days);

  it("終了の 31 日前は出ず、30 日前から出る", () => {
    expect(expiring("2026-01-09")).toEqual([]);
    expect(expiring("2026-01-10")).toEqual([30]);
  });
});

describe("ポイント利用の案内：1日あたりの上限", () => {
  const rules = variant((r) => {
    const redemption = r.redemptions[0];
    if (redemption) redemption.meta.cap = { amount: 3000, unit: "point", period: "day" };
  });
  const at = (amount_yen: number) =>
    recommend({ rules, store_id: "store_v", amount_yen, date: "2026-01-15" }).redemptions[0];

  it("1日の上限も 1会計の上限として反映し、期間を返す（上限ちょうど／超過）", () => {
    expect(at(3900)).toMatchObject({ cap_points: 3000, cap_period: "day", use_points: 3000, remainder_yen: 0 });
    expect(at(3901)).toMatchObject({ cap_points: 3000, cap_period: "day", use_points: 3000, remainder_yen: 1 });
  });

  it("上限を無視して大量のポイントを案内しない", () => {
    expect(at(30_000)).toMatchObject({ use_points: 3000, covered_yen: 3900, remainder_yen: 26_100 });
  });
});

describe("年間目標：目標のあるカードが複数遅れている場合", () => {
  // カードB にも目標を付け、差し込み払いを集計対象にする
  const rules = variant((r) => {
    const a = r.cards.find((c) => c.id === "card_a");
    const b = r.cards.find((c) => c.id === "card_b");
    if (a?.annual_target && b) b.annual_target = structuredClone(a.annual_target);
    const method = r.methods.find((m) => m.id === "card_b_insert");
    if (method) method.counts_toward_annual = true;
  });
  const both_behind = { card_a: 100_000, card_b: 100_000 };
  const advise = (input: Partial<AdviseInput>) =>
    recommend({ rules, store_id: null, amount_yen: 1000, date: DATE, annual_spent_yen: both_behind, ...input });

  it("どちらも閾値以内なら、順位が上のほうを1位にし、もう一方は知らせる", () => {
    // 未登録の店：カードC 15 円、カードA 10 円、カードB 10 円
    const r = advise({});
    expect(r.promotion?.card_id).toBe("card_a");
    expect(r.pace_alert_card_ids).toEqual(["card_b"]);
  });

  it("1位が遅れているカードなら入れ替えず、他の遅れているカードを知らせる", () => {
    // 店舗T：カードB 30 円が1位、カードA は 10 円
    const r = advise({ store_id: "store_t" });
    expect(r.advices[0]?.candidate.method.id).toBe("card_b_insert");
    expect(r.promotion).toBeNull();
    expect(r.pace_alert_card_ids).toEqual(["card_a"]);
  });

  it("片方だけ閾値以内なら、そのカードを1位にする", () => {
    // カードA の手段を無効にすると、遅れていて払えるのはカードB だけ
    const r = advise({ disabled_method_ids: ["card_a_gpay", "card_a_insert"] });
    expect(r.promotion?.card_id).toBe("card_b");
    expect(r.pace_alert_card_ids).toEqual([]);
  });
});

describe("年間目標：閾値の既定値と検査", () => {
  it("閾値を省略すると既定値（5 円）が使われる", () => {
    const r = recommend({ rules: base, store_id: null, amount_yen: 1000, date: DATE, annual_spent_yen: { card_a: 0 } });
    expect(r.promotion?.diff_milliyen).toBe(5_000);
  });

  it("負の閾値は例外にする", () => {
    expect(() =>
      recommend({ rules: base, store_id: null, amount_yen: 1000, date: DATE, annual_threshold_yen: -1 }),
    ).toThrow(RangeError);
  });
});

describe("入力の検査", () => {
  it("存在しない日付は例外にする", () => {
    expect(() => rankMethods({ rules: base, store_id: null, amount_yen: 1000, date: "2026-13-45" })).toThrow(RangeError);
    expect(() => rankMethods({ rules: base, store_id: null, amount_yen: 1000, date: "2026-02-30" })).toThrow(RangeError);
  });

  it("金額は上限ちょうどまで受け付け、超えると例外にする", () => {
    expect(() => rankMethods({ rules: base, store_id: null, amount_yen: MAX_AMOUNT_YEN, date: DATE })).not.toThrow();
    expect(() => rankMethods({ rules: base, store_id: null, amount_yen: MAX_AMOUNT_YEN + 1, date: DATE })).toThrow(RangeError);
  });
});

describe("parseRules：追加した検査", () => {
  it("暦に存在しない日付は不合格（確認日・有効期間・更新日）", () => {
    expect(invalid((r) => { rewardOf(r, "card_a", "card_a_base").meta.last_verified = "2026-02-31"; })
      .some((e) => e.includes("last_verified") && e.includes("2026-02-31"))).toBe(true);
    expect(invalid((r) => { rewardOf(r, "card_a", "card_a_base").meta.valid_to = "2026-04-31"; })
      .some((e) => e.includes("valid_to"))).toBe(true);
    expect(invalid((r) => { r.updated_at = "2026-02-30"; }).some((e) => e.includes("updated_at"))).toBe(true);
  });

  it("適用条件の空の一覧は不合格（どの店にも該当しない条件になるため）", () => {
    const errors = invalid((r) => { rewardOf(r, "card_a", "card_a_base").applies.store_ids = []; });
    expect(errors.some((e) => e.includes("/cards/0/rewards/0/applies/store_ids"))).toBe(true);
  });

  it("計算単位あたりの還元額が大きすぎるルールは不合格", () => {
    const errors = invalid((r) => {
      const rule = rewardOf(r, "card_a", "card_a_base");
      rule.points_per_unit = 100_000;
      rule.multiplier = 100;
    });
    expect(errors.some((e) => e.includes("大きすぎます"))).toBe(true);
  });

  it("Schema の上限を超える値は不合格", () => {
    expect(invalid((r) => { rewardOf(r, "card_a", "card_a_base").multiplier = 101; }).length).toBeGreaterThan(0);
    expect(invalid((r) => { const p = r.points[0]; if (p) p.value_milliyen = 1_000_001; }).length).toBeGreaterThan(0);
  });

  it("チャージ元に存在しないカードを指定した手段は不合格", () => {
    const errors = invalid((r) => {
      const m = r.methods.find((x) => x.id === "transit_from_card_b");
      if (m?.funding) m.funding.card_id = "card_none";
    });
    expect(errors.some((e) => e.includes("card_none"))).toBe(true);
  });

  it("直接払うカードとチャージ元を同時に指定した手段は不合格", () => {
    const errors = invalid((r) => {
      const m = r.methods.find((x) => x.id === "transit_from_card_b");
      if (m) m.card_id = "card_b";
    });
    expect(errors.some((e) => e.includes("同時に指定できません"))).toBe(true);
  });

  it("店舗に、存在しない手段を使えない手段として登録すると不合格", () => {
    const errors = invalid((r) => {
      const s = r.stores.find((x) => x.id === "store_v");
      if (s) s.unusable_method_ids = ["method_none"];
    });
    expect(errors.some((e) => e.includes("method_none"))).toBe(true);
  });

  it("ポイント利用の案内が、存在しないポイントや店舗を参照すると不合格", () => {
    expect(invalid((r) => { const x = r.redemptions[0]; if (x) x.point_id = "point_none"; })
      .some((e) => e.includes("point_none"))).toBe(true);
    expect(invalid((r) => { const x = r.redemptions[0]; if (x) x.store_ids = ["store_none"]; })
      .some((e) => e.includes("store_none"))).toBe(true);
  });

  it("還元ルールの id が、カードと手段をまたいで重複すると不合格", () => {
    const errors = invalid((r) => {
      const rule = r.methods.find((m) => m.id === "qr_from_bank")?.rewards?.[0];
      if (rule) rule.id = "card_a_base";
    });
    expect(errors.some((e) => e.includes("重複") && e.includes("card_a_base"))).toBe(true);
  });

  it("ルートに $schema（エディタの補完用）を書いても合格する", () => {
    const copy = { ...structuredClone(sample), $schema: "../schema/rules.schema.json" };
    expect(parseRules(copy).ok).toBe(true);
  });
});

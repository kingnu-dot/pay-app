import { describe, expect, it } from "vitest";
import { recommend } from "../src/engine/advise";
import { normalizeText, searchStores } from "../src/engine/search";
import { adjustmentFor, sumAnnualSpent } from "../src/engine/spend";
import { defaultSettings, mergeRules, newCustomStoreId, normalizeSettings, type Settings } from "../src/settings/settings";
import { parseRules } from "../src/rules/validate";
import type { Rules } from "../src/rules/types";
import { breakdownLine, noticeText, problemText, reasonText, redemptionDetail } from "../src/ui/explain";
import {
  formatCap,
  formatDate,
  formatMilliyen,
  formatRate,
  formatYen,
  milliyenToInput,
  parseAmount,
  parseYenValue,
} from "../src/ui/format";
import sample from "./fixtures/sample-rules.json";

const parsed = parseRules(sample);
if (!parsed.ok) throw new Error("サンプルルールが不正です");
const rules: Rules = parsed.rules;
const DATE = "2026-01-10";
const settingsWith = (change: Partial<Settings>): Settings => ({ ...defaultSettings(), ...change });

describe("mergeRules：個人設定の合成", () => {
  it("既定の設定では、公式ルールと同じ内容になる", () => {
    expect(mergeRules(rules, defaultSettings())).toEqual({ rules, errors: [] });
  });

  it("公式ルールそのものは書き換えない", () => {
    const before = structuredClone(rules);
    mergeRules(rules, settingsWith({ point_values_milliyen: { point_x: 1500 } }));
    expect(rules).toEqual(before);
  });

  it("ポイントの評価額を上書きすると、判定の円換算額に反映される", () => {
    const merged = mergeRules(rules, settingsWith({ point_values_milliyen: { point_x: 1500 } })).rules;
    const top = recommend({ rules: merged, store_id: "store_s", amount_yen: 1000, date: DATE }).advices[0];
    // 基本 10pt + 加算 40pt = 50pt × 1.5 円
    expect(top?.candidate.total_milliyen).toBe(75_000);
  });

  it("追加した店舗は一般加盟店として判定でき、通販の区分も引き継ぐ", () => {
    const merged = mergeRules(
      rules,
      settingsWith({
        custom_stores: [
          { id: "user_store_1", name: "店舗X", aliases: ["エックス"], channel: "in_store" },
          { id: "user_store_2", name: "通販Y", aliases: [], channel: "online" },
        ],
      }),
    ).rules;
    expect(merged.stores.map((s) => s.id).slice(-2)).toEqual(["user_store_1", "user_store_2"]);
    const online = recommend({ rules: merged, store_id: "user_store_2", amount_yen: 1000, date: DATE });
    expect(online.advices.map((a) => a.candidate.method.id)).toEqual(["card_c_online"]);
  });

  it("別名を追加できる（重複は1つにまとめる）", () => {
    const merged = mergeRules(rules, settingsWith({ extra_aliases: { store_s: ["エス", "えすてん"] } })).rules;
    expect(merged.stores.find((s) => s.id === "store_s")?.aliases).toEqual(["エス", "S店", "えすてん"]);
  });

  it("店舗単位の例外を登録すると、その店ではそのルールが適用されない", () => {
    const merged = mergeRules(
      rules,
      settingsWith({ store_exceptions: [{ store_id: "store_s", rule_id: "card_a_touch_bonus" }] }),
    ).rules;
    const gpay = recommend({ rules: merged, store_id: "store_s", amount_yen: 1000, date: DATE }).advices.find(
      (a) => a.candidate.method.id === "card_a_gpay",
    );
    expect(gpay?.candidate.total_milliyen).toBe(10_000);
  });

  it("その店で使えない手段を登録すると、候補から外れる", () => {
    const merged = mergeRules(rules, settingsWith({ unusable_methods: { store_s: ["card_a_gpay"] } })).rules;
    const ids = recommend({ rules: merged, store_id: "store_s", amount_yen: 1000, date: DATE }).advices.map(
      (a) => a.candidate.method.id,
    );
    expect(ids).not.toContain("card_a_gpay");
  });

  it("年間目標の集計開始日を上書きできる", () => {
    const merged = mergeRules(rules, settingsWith({ annual_period_start: { card_a: { month: 1, day: 1 } } })).rules;
    const r = recommend({ rules: merged, store_id: null, amount_yen: 1000, date: DATE });
    expect(r.annual[0]?.status.period).toEqual({ start: "2026-01-01", end: "2026-12-31" });
  });

  it("存在しない id を指す設定は無視する", () => {
    const merged = mergeRules(
      rules,
      settingsWith({
        point_values_milliyen: { point_none: 5000 },
        extra_aliases: { store_none: ["x"] },
        store_exceptions: [{ store_id: "store_none", rule_id: "card_a_base" }, { store_id: "store_s", rule_id: "rule_none" }],
        unusable_methods: { store_s: ["method_none"] },
      }),
    );
    expect(merged).toEqual({ rules, errors: [] });
  });

  it("合成後のルールに問題があれば、公式ルールのまま使い、理由を返す", () => {
    // 評価額を上限いっぱいにすると、計算単位あたりの還元額が大きすぎて不合格になる
    const merged = mergeRules(rules, settingsWith({ point_values_milliyen: { point_x: 1_000_000 } }));
    expect(merged.rules).toBe(rules);
    expect(merged.errors.length).toBeGreaterThan(0);
  });
});

describe("normalizeSettings：保存データの読み取り", () => {
  it("壊れた値や未知の値は既定値にする", () => {
    expect(normalizeSettings(null)).toEqual(defaultSettings());
    expect(normalizeSettings("x")).toEqual(defaultSettings());
    expect(normalizeSettings({ annual_threshold_yen: -1, disabled_method_ids: "a", custom_stores: [{ id: "store_s", name: "x" }] }))
      .toEqual(defaultSettings());
  });

  it("正しい値はそのまま読み取り、不正な項目だけ捨てる", () => {
    const s = normalizeSettings({
      point_values_milliyen: { point_x: 1500, point_y: 1.5, point_z: -1 },
      annual_threshold_yen: 10,
      annual_period_start: { card_a: { month: 2, day: 1 }, card_b: { month: 13, day: 1 }, card_c: { month: 2, day: 30 } },
      disabled_method_ids: ["m1", "m1", 3, ""],
      favorite_store_ids: ["store_s"],
      custom_stores: [
        { id: "user_store_1", name: " 店舗X ", aliases: ["a", 1], channel: "online" },
        { id: "user_store_1", name: "重複" },
        { id: "USER_bad", name: "不正な id" },
      ],
      extra_aliases: { store_s: ["えす"], store_t: [] },
      store_exceptions: [{ store_id: "store_s", rule_id: "r1" }, { store_id: "store_s" }],
      unusable_methods: { store_s: ["m1"] },
      enabled_service_ids: ["app_s", "app_s", 5],
      custom_services: [
        { id: "user_service_1", name: " 優待X ", store_ids: ["store_s"], url: "https://example.com/x" },
        { id: "user_service_2", name: "リンクが危険", store_ids: [], url: "javascript:alert(1)" },
        { id: "user_service_3", name: "http は不可", store_ids: [], url: "http://example.com/" },
        { id: "service_bad", name: "不正な id", store_ids: [], url: null },
      ],
    });
    expect(s).toEqual({
      version: 1,
      point_values_milliyen: { point_x: 1500 },
      annual_threshold_yen: 10,
      annual_period_start: { card_a: { month: 2, day: 1 } },
      disabled_method_ids: ["m1"],
      favorite_store_ids: ["store_s"],
      custom_stores: [{ id: "user_store_1", name: "店舗X", aliases: ["a"], channel: "online" }],
      extra_aliases: { store_s: ["えす"] },
      store_exceptions: [{ store_id: "store_s", rule_id: "r1" }],
      unusable_methods: { store_s: ["m1"] },
      enabled_service_ids: ["app_s"],
      custom_services: [
        { id: "user_service_1", name: "優待X", store_ids: ["store_s"], url: "https://example.com/x" },
        { id: "user_service_2", name: "リンクが危険", store_ids: [], url: null },
        { id: "user_service_3", name: "http は不可", store_ids: [], url: null },
      ],
    });
  });

  it("保存して読み直しても同じ内容になる", () => {
    const s = settingsWith({ favorite_store_ids: ["store_s"], annual_threshold_yen: 8 });
    expect(normalizeSettings(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe("newCustomStoreId", () => {
  it("既存と重ならない id を作る", () => {
    expect(newCustomStoreId([])).toBe("user_store_1");
    expect(newCustomStoreId(["user_store_1", "user_store_2"])).toBe("user_store_3");
  });
});

describe("searchStores：店舗の検索", () => {
  const ids = (query: string, favorites: string[] = []) => searchStores(rules.stores, query, favorites).map((s) => s.id);

  it("検索語が空なら、お気に入りを先頭にして全件を返す", () => {
    expect(ids("")).toEqual(["store_s", "store_t", "store_u", "store_v", "store_w"]);
    expect(ids("", ["store_v"])).toEqual(["store_v", "store_s", "store_t", "store_u", "store_w"]);
  });

  it("名前と別名のどちらでも見つかる", () => {
    expect(ids("店舗T")).toEqual(["store_t"]);
    expect(ids("ブイ")).toEqual(["store_v"]);
  });

  it("全角と半角、大文字と小文字、カタカナとひらがなを区別しない", () => {
    expect(ids("ｓ店")).toEqual(["store_s"]);
    expect(ids("えす")).toEqual(["store_s"]);
    expect(normalizeText(" ＡＢｃ カナ ")).toBe("abcかな");
  });

  it("前方一致を先に、次にお気に入りを並べる", () => {
    expect(ids("店舗")).toEqual(["store_s", "store_t", "store_u", "store_v"]);
    expect(ids("店舗", ["store_u"])).toEqual(["store_u", "store_s", "store_t", "store_v"]);
  });

  it("一致しなければ空", () => {
    expect(ids("存在しない店")).toEqual([]);
  });
});

describe("利用額の集計", () => {
  const period = { start: "2025-04-01", end: "2026-03-31" };
  const entries = [
    { date: "2025-03-31", amount_yen: 1000, annual_card_id: "card_a" }, // 期間の前
    { date: "2025-04-01", amount_yen: 2000, annual_card_id: "card_a" }, // 初日
    { date: "2026-03-31", amount_yen: 3000, annual_card_id: "card_a" }, // 最終日
    { date: "2026-04-01", amount_yen: 4000, annual_card_id: "card_a" }, // 期間の後
    { date: "2025-10-01", amount_yen: 5000, annual_card_id: null }, // 集計対象外
    { date: "2025-10-01", amount_yen: 6000, annual_card_id: "card_b" }, // 別のカード
    { date: "2025-12-01", amount_yen: -500, annual_card_id: "card_a" }, // 補正
  ];

  it("期間内（両端を含む）の、そのカードの計上分だけを合計する", () => {
    expect(sumAnnualSpent(entries, "card_a", period)).toBe(4500);
    expect(sumAnnualSpent(entries, "card_b", period)).toBe(6000);
    expect(sumAnnualSpent([], "card_a", period)).toBe(0);
  });

  it("累計の上書き入力は、差額を補正として返す", () => {
    expect(adjustmentFor(4500, 300_000)).toBe(295_500);
    expect(adjustmentFor(4500, 4000)).toBe(-500);
    expect(adjustmentFor(4500, 4500)).toBe(0);
    expect(() => adjustmentFor(0, -1)).toThrow(RangeError);
  });
});

describe("表示の整形", () => {
  it("金額と還元率", () => {
    expect(formatYen(1234567)).toBe("1,234,567円");
    expect(formatMilliyen(105_000)).toBe("105円");
    expect(formatMilliyen(10_500)).toBe("10.5円");
    expect(formatMilliyen(1_485)).toBe("1.4円");
    expect(formatMilliyen(0)).toBe("0円");
    expect(formatRate(50_000)).toBe("5%");
    expect(formatRate(105_000)).toBe("10.5%");
    expect(formatRate(7_500)).toBe("0.75%");
    expect(formatRate(0)).toBe("0%");
  });

  it("評価額の入力：円の小数を 1/1000 円にし、入力欄へ戻すときは末尾の 0 を省く", () => {
    expect(parseYenValue("1.5")).toBe(1500);
    expect(parseYenValue("1")).toBe(1000);
    expect(parseYenValue("０．７５円")).toBe(750);
    expect(parseYenValue("0.001")).toBe(1);
    expect(parseYenValue("1.2345")).toBeNull();
    expect(parseYenValue("-1")).toBeNull();
    expect(parseYenValue("")).toBeNull();
    expect(milliyenToInput(1500)).toBe("1.5");
    expect(milliyenToInput(1000)).toBe("1");
    expect(milliyenToInput(750)).toBe("0.75");
    expect(milliyenToInput(0)).toBe("0");
  });

  it("上限と日付", () => {
    expect(formatCap({ amount: 3000, unit: "point", period: "txn" })).toBe("1会計あたり 3,000 ポイントまで");
    expect(formatCap({ amount: 500, unit: "point", period: "month" })).toBe("月間 500 ポイントまで");
    expect(formatDate("2026-01-05")).toBe("2026/1/5");
  });

  it("金額の入力：空欄は未入力、全角やカンマも読める、数字以外は誤り", () => {
    expect(parseAmount("")).toEqual({ ok: true, amount_yen: null });
    expect(parseAmount("1,000")).toEqual({ ok: true, amount_yen: 1000 });
    expect(parseAmount("１２００円")).toEqual({ ok: true, amount_yen: 1200 });
    expect(parseAmount("0")).toEqual({ ok: true, amount_yen: 0 });
    expect(parseAmount("12.5").ok).toBe(false);
    expect(parseAmount("-5").ok).toBe(false);
    expect(parseAmount("abc").ok).toBe(false);
    expect(parseAmount("99999999999").ok).toBe(false);
    expect(parseAmount("1000000001").ok).toBe(false);
  });
});

describe("判定結果の文章", () => {
  const at = (store_id: string | null, amount_yen: number | null, extra = {}) =>
    recommend({ rules, store_id, amount_yen, date: DATE, annual_spent_yen: { card_a: 500_000 }, ...extra });

  it("内訳：実付与量は「ポイント × 評価額」、期待値は「金額 × 還元率」で示す", () => {
    const top = at("store_s", 1000).advices[0]?.candidate;
    expect(top?.components.map((c) => breakdownLine(c, 1000))).toEqual([
      "基本：1,000円 × 1%（ポイントX、期待値）＝ 10円",
      "スマホタッチ加算：40 ポイントX × 1円 ＝ 40円",
    ]);
  });

  it("内訳：金額未入力のときは還元率だけ、チャージ時の還元にはその旨を付ける", () => {
    const r = at("store_s", null);
    expect(breakdownLine(r.advices[0]!.candidate.components[0]!, null)).toBe("基本：1%（ポイントX）");
    const transit = at("store_s", 1000).advices.find((a) => a.candidate.method.id === "transit_from_card_b");
    expect(breakdownLine(transit!.candidate.components[0]!, 1000)).toBe(
      "チャージ時：交通系チャージ：1,000円 × 0.8%（ポイントZ、期待値）＝ 8円",
    );
  });

  it("理由：通常は還元の差、年間目標で入れ替えたときはその旨", () => {
    expect(reasonText(at("store_s", 1000))).toBe("還元が最大（基本＋スマホタッチ加算）。2位との差は 35円。");
    expect(reasonText(at("store_s", null))).toBe("還元率が最大（基本＋スマホタッチ加算）。");
    expect(reasonText(at(null, 1000, { annual_spent_yen: { card_a: 0 } }))).toBe(
      "年間目標の達成ペース確保のため（還元が最大の手段との差は 5円）。",
    );
    expect(reasonText(at("store_w", 1000, { disabled_method_ids: ["card_c_online"] }))).toBe(
      "この店で使える支払い手段がありません。",
    );
  });

  it("注意事項の文言", () => {
    const transit = at("store_s", 1000).advices.find((a) => a.candidate.method.id === "transit_from_card_b");
    expect(transit?.notices.map(noticeText)).toEqual([
      "「交通系チャージ」は公式情報で未確認です。",
      "「交通系チャージ」は要再確認（最終確認 2025/9/1）。",
    ]);
  });

  it("ポイント利用の案内の補足", () => {
    const r = (amount_yen: number | null) => recommend({ rules, store_id: "store_v", amount_yen, date: "2026-01-15" }).redemptions[0]!;
    expect(redemptionDetail(r(1000))).toBe("770 ポイントXで 1,000円分");
    expect(redemptionDetail(r(5000))).toBe("3,000 ポイントXで 3,900円分。残り 1,100円は下の手段で");
    expect(redemptionDetail(r(null))).toBe("上限 3,000 ポイントX");
  });

  it("ルール取得の問題：トークン切れは更新を促し、未設定でもルールがあれば何も出さない", () => {
    expect(problemText(null, true)).toBeNull();
    expect(problemText({ kind: "not_configured" }, true)).toBeNull();
    expect(problemText({ kind: "not_configured" }, false)).toContain("設定画面");
    expect(problemText({ kind: "unauthorized" }, true)).toBe(
      "トークンを更新してください（無効または期限切れ）。保存済みのルールで動作しています。",
    );
    expect(problemText({ kind: "network_error" }, true)).toContain("オフライン");
    expect(problemText({ kind: "invalid", errors: ["/points: must be array"] }, true)).toContain("/points: must be array");
  });
});

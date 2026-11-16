// 判定エンジンの中核：支払い手段ごとの還元を計算し、円換算額の大きい順に並べる
// 画面や保存に依存しない純粋な関数だけを置く

import { assertInt, divFloor } from "./money";
import { pointsPerTxn } from "./reward";
import type { Cap, Meta, Method, PayType, Point, RewardRule, Rules, Store } from "../rules/types";

export interface RankInput {
  /** 公式ルールと個人上書きを合成済みのルール */
  rules: Rules;
  /** 店舗の id。未登録の店（一般加盟店）は null */
  store_id: string | null;
  /** 支払い金額 [円]。未入力は null（還元率だけで比較する） */
  amount_yen: number | null;
  /** 判定日（YYYY-MM-DD、Asia/Tokyo の暦日） */
  date: string;
  /** 個人設定で無効にした支払い手段 */
  disabled_method_ids?: readonly string[];
}

/** 還元の内訳1件 */
export interface RewardComponent {
  rule_id: string;
  label: string;
  point_id: string;
  point_name: string;
  /** card：カードの還元 / charge：チャージ時の還元 / method：手段そのものの還元 */
  source: "card" | "charge" | "method";
  /** actual：端数処理後の実付与量 / expected：期待値（月間合算・チャージ） / rate：金額未入力 */
  basis: "actual" | "expected" | "rate";
  /** 実付与量 [ポイント]。basis が actual のときだけ入る */
  points: number | null;
  /** 円換算額 [1/1000 円]。金額未入力のときは null */
  value_milliyen: number | null;
  /** 名目の還元率 [ppm]（1% = 10,000） */
  rate_ppm: number;
  /** 1回の利用以外の上限（計算には反映していない。表示用） */
  cap_note: Cap | null;
  /** 出典が未検証のルールか */
  unverified: boolean;
  /** 出典と有効期間 */
  meta: Meta;
}

/** 支払い手段1件の判定結果 */
export interface Candidate {
  method: Method;
  components: RewardComponent[];
  /** 円換算の還元額の合計 [1/1000 円]。金額未入力のときは null */
  total_milliyen: number | null;
  /** 還元率 [ppm]。金額があれば実効値（合計 ÷ 金額）、なければ名目値の合計 */
  rate_ppm: number;
}

export interface Ranking {
  /** 解決した店舗。未登録の店は null */
  store: Store | null;
  /** 還元の大きい順 */
  candidates: Candidate[];
}

/** 適用条件の判定に使う状況 */
interface MatchContext {
  pay_type: PayType;
  store: Store | null;
  /** 店舗が属する（有効期間内の）店舗グループ */
  group_ids: ReadonlySet<string>;
  date: string;
  day_of_month: number;
}

const DATE_PATTERN = /^\d{4}-(\d{2})-(\d{2})$/;

/** YYYY-MM-DD から日（1〜31）を取り出す */
export function dayOfMonth(date: string): number {
  const m = DATE_PATTERN.exec(date);
  if (!m) throw new RangeError(`日付は YYYY-MM-DD で指定してください: ${date}`);
  return Number(m[2]);
}

/** 有効期間内か（両端を含む。null は制限なし）。YYYY-MM-DD は文字列のまま大小比較できる */
export function isActive(meta: Pick<Meta, "valid_from" | "valid_to">, date: string): boolean {
  if (meta.valid_from !== null && date < meta.valid_from) return false;
  if (meta.valid_to !== null && date > meta.valid_to) return false;
  return true;
}

function isChargePayType(pay_type: PayType): boolean {
  return pay_type.startsWith("charge_");
}

/** 還元ルールが、この状況で適用されるか */
function ruleApplies(rule: RewardRule, ctx: MatchContext): boolean {
  const a = rule.applies;
  if (a.pay_types) {
    if (!a.pay_types.includes(ctx.pay_type)) return false;
  } else if (isChargePayType(ctx.pay_type)) {
    // 払い方を省略したルールは購入だけが対象。チャージには明示したルールだけを使う
    return false;
  }
  if (a.store_group_ids || a.store_ids) {
    const store = ctx.store;
    if (!store) return false;
    const in_group = (a.store_group_ids ?? []).some((id) => ctx.group_ids.has(id));
    const in_ids = (a.store_ids ?? []).includes(store.id);
    if (!in_group && !in_ids) return false;
  }
  if (ctx.store && a.exclude_store_ids?.includes(ctx.store.id)) return false;
  if (a.days_of_month && !a.days_of_month.includes(ctx.day_of_month)) return false;
  return isActive(rule.meta, ctx.date);
}

/** 還元ルール1件を評価して内訳にする */
function evaluate(
  rule: RewardRule,
  point: Point,
  amount_yen: number | null,
  source: RewardComponent["source"],
): RewardComponent {
  const multiplier = rule.multiplier ?? 1;
  const per_unit_milliyen = rule.points_per_unit * multiplier * point.value_milliyen;
  const cap = rule.meta.cap;
  const txn_cap = cap !== null && cap.period === "txn" ? cap : null;
  const component: RewardComponent = {
    rule_id: rule.id,
    label: rule.label,
    point_id: point.id,
    point_name: point.name,
    source,
    basis: "rate",
    points: null,
    value_milliyen: null,
    rate_ppm: divFloor(per_unit_milliyen * 1000, rule.unit_yen),
    cap_note: cap !== null && cap.period !== "txn" ? cap : null,
    unverified: rule.meta.confidence === "unverified",
    meta: rule.meta,
  };
  if (amount_yen === null) return component;

  // 1回あたりの上限が金額で決まっている場合は、対象金額を先に切り詰める
  const eligible_yen = txn_cap?.unit === "yen" ? Math.min(amount_yen, txn_cap.amount) : amount_yen;
  const point_limit = txn_cap?.unit === "point" ? txn_cap.amount : null;

  // チャージは利用額と同額を按分して考えるため、端数処理はせず期待値で比較する
  if (rule.scope === "per_txn" && source !== "charge") {
    const raw_points = pointsPerTxn(rule, eligible_yen);
    const points = point_limit === null ? raw_points : Math.min(raw_points, point_limit);
    return { ...component, basis: "actual", points, value_milliyen: points * point.value_milliyen };
  }
  const expected_milliyen = divFloor(eligible_yen * per_unit_milliyen, rule.unit_yen);
  const value_milliyen =
    point_limit === null ? expected_milliyen : Math.min(expected_milliyen, point_limit * point.value_milliyen);
  return { ...component, basis: "expected", value_milliyen };
}

/** 比較用の大きさ（金額があれば円換算額、なければ還元率） */
function magnitude(c: RewardComponent): number {
  return c.value_milliyen ?? c.rate_ppm;
}

/**
 * 適用されるルールを選んで内訳にする。
 * - 「基本」は1件だけ採用する。「基本を置き換え」が適用されるときは、そちらを基本として採用する
 * - 同じ種類が複数あるときは、還元が最大のものを採用する
 * - 「上乗せ」は適用されるものをすべて足す
 */
function selectComponents(
  rules: readonly RewardRule[],
  ctx: MatchContext,
  points: ReadonlyMap<string, Point>,
  amount_yen: number | null,
  source: RewardComponent["source"],
): RewardComponent[] {
  const bases: RewardComponent[] = [];
  const replacements: RewardComponent[] = [];
  const additions: RewardComponent[] = [];
  for (const rule of rules) {
    if (!ruleApplies(rule, ctx)) continue;
    const point = points.get(rule.point_id);
    if (!point) throw new Error(`存在しないポイントを参照しています: ${rule.point_id}`);
    const component = evaluate(rule, point, amount_yen, source);
    if (rule.stacking === "base") bases.push(component);
    else if (rule.stacking === "replace_base") replacements.push(component);
    else additions.push(component);
  }
  const pool = replacements.length > 0 ? replacements : bases;
  const main = pool.reduce<RewardComponent | null>(
    (best, c) => (best === null || magnitude(c) > magnitude(best) ? c : best),
    null,
  );
  return main === null ? additions : [main, ...additions];
}

/** その店舗で、その支払い手段を使えるか */
function isUsable(method: Method, store: Store | null, disabled: ReadonlySet<string>): boolean {
  if (disabled.has(method.id)) return false;
  // ポイント払いは順位に入れず、案内として別に表示する
  if (method.pay_type === "point_use") return false;
  const is_online_store = store?.channel === "online";
  if (is_online_store !== (method.pay_type === "online")) return false;
  if (store?.unusable_pay_types?.includes(method.pay_type)) return false;
  if (store?.unusable_method_ids?.includes(method.id)) return false;
  return true;
}

/** 支払い手段ごとの還元を計算し、大きい順に並べる */
export function rankMethods(input: RankInput): Ranking {
  const { rules, amount_yen, date } = input;
  if (amount_yen !== null) {
    assertInt(amount_yen, "amount_yen");
    if (amount_yen < 0) throw new RangeError(`amount_yen は 0 以上である必要があります: ${amount_yen}`);
  }
  const day_of_month = dayOfMonth(date);
  const store = rules.stores.find((s) => s.id === input.store_id) ?? null;
  const points = new Map(rules.points.map((p) => [p.id, p]));
  const cards = new Map(rules.cards.map((c) => [c.id, c]));
  const disabled = new Set(input.disabled_method_ids ?? []);
  const group_ids = new Set(
    store === null
      ? []
      : rules.store_groups
          .filter((g) => g.store_ids.includes(store.id) && isActive(g.meta, date))
          .map((g) => g.id),
  );
  const purchase_ctx = (pay_type: PayType): MatchContext => ({ pay_type, store, group_ids, date, day_of_month });
  // チャージは店舗で行うものではないので、店舗の条件が付いたルールは適用しない
  const charge_ctx = (pay_type: PayType): MatchContext => ({
    pay_type,
    store: null,
    group_ids: new Set(),
    date,
    day_of_month,
  });

  const candidates: Candidate[] = [];
  for (const method of rules.methods) {
    if (!isUsable(method, store, disabled)) continue;
    const components: RewardComponent[] = [];
    if (method.earns_points) {
      const card = method.card_id === null ? undefined : cards.get(method.card_id);
      if (card) {
        components.push(...selectComponents(card.rewards, purchase_ctx(method.pay_type), points, amount_yen, "card"));
      }
      const funding_card =
        method.funding && method.funding.card_id !== null ? cards.get(method.funding.card_id) : undefined;
      if (method.funding && funding_card) {
        components.push(
          ...selectComponents(funding_card.rewards, charge_ctx(method.funding.pay_type), points, amount_yen, "charge"),
        );
      }
      components.push(
        ...selectComponents(method.rewards ?? [], purchase_ctx(method.pay_type), points, amount_yen, "method"),
      );
    }
    const nominal_rate_ppm = components.reduce((sum, c) => sum + c.rate_ppm, 0);
    const total_milliyen =
      amount_yen === null ? null : components.reduce((sum, c) => sum + (c.value_milliyen ?? 0), 0);
    const rate_ppm =
      total_milliyen !== null && amount_yen !== null && amount_yen > 0
        ? divFloor(total_milliyen * 1000, amount_yen)
        : nominal_rate_ppm;
    candidates.push({ method, components, total_milliyen, rate_ppm });
  }

  // 円換算額の大きい順。同額なら還元率、それも同じならルールに書かれた順（安定ソート）
  candidates.sort(
    (a, b) => (b.total_milliyen ?? 0) - (a.total_milliyen ?? 0) || b.rate_ppm - a.rate_ppm,
  );
  return { store, candidates };
}

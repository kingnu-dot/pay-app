// 判定の入口：順位付けに、年間目標の優先・注意事項・ポイント利用の案内を加える

import { annualPeriod, annualStatus, type AnnualStatus } from "./annual";
import { daysBetween } from "./dates";
import { assertInt, divCeil, divFloor, MILLIYEN_PER_YEN } from "./money";
import { dayOfMonth, isActive, rankMethods, type Candidate, type RankInput } from "./recommend";
import type { Cap, Loyalty, Meta, Method, Redemption, RewardRule, Rules, Store } from "../rules/types";

/** last_verified がこの日数以上前のルールに「要再確認」を付ける [日] */
export const STALE_DAYS = 90;
/** valid_to までこの日数以内のルールを「まもなく終了」とする [日] */
export const EXPIRING_DAYS = 30;

export interface AdviseInput extends RankInput {
  /** カードごとの、今期の年間利用額の累計（集計対象の決済だけ）[円]。記録がないカードは 0 として扱う */
  annual_spent_yen?: Readonly<Record<string, number>>;
  /** ペース遅れのとき、1位との差がこの額以内なら目標のあるカードを優先する [円] */
  annual_threshold_yen?: number;
}

/** 候補に付ける注意事項 */
export type Notice =
  | { kind: "method_warning"; text: string }
  | { kind: "unverified"; rule_id: string; label: string }
  | { kind: "stale"; rule_id: string; label: string; last_verified: string }
  | { kind: "cap"; rule_id: string; label: string; cap: Cap };

export interface Advice {
  candidate: Candidate;
  notices: Notice[];
}

/** 年間目標のために順位を入れ替えた記録 */
export interface Promotion {
  method_id: string;
  card_id: string;
  /** 入れ替え前の1位との差 [1/1000 円] */
  diff_milliyen: number;
}

/** 年間目標の状況（カードごと） */
export interface AnnualAdvice {
  card_id: string;
  card_name: string;
  status: AnnualStatus;
}

/** ポイント利用の案内 */
export interface RedemptionNotice {
  redemption: Redemption;
  point_name: string;
  /** 1会計で使えるポイントの上限 [ポイント]。上限なしは null */
  cap_points: number | null;
  /** この会計で使うポイント数 [ポイント]。金額未入力は null */
  use_points: number | null;
  /** ポイントで払える額 [円]。金額未入力は null */
  covered_yen: number | null;
  /** ポイントで払いきれず、他の手段で払う額 [円]。金額未入力は null */
  remainder_yen: number | null;
}

export interface Recommendation {
  store: Store | null;
  /** 推奨順（年間目標による入れ替えを反映済み） */
  advices: Advice[];
  promotion: Promotion | null;
  /** ペース遅れだが、金額未入力などで入れ替えを行わなかったカード */
  pace_alert_card_ids: string[];
  annual: AnnualAdvice[];
  redemptions: RedemptionNotice[];
  /** 会計時に提示するポイントカード */
  loyalty: Loyalty[];
}

/** 年間利用額に計上されるカード（チャージ型はチャージ元のカード） */
function annualCardId(method: Method): string | null {
  if (!method.counts_toward_annual) return null;
  return method.card_id ?? method.funding?.card_id ?? null;
}

function isStale(meta: Meta, date: string): boolean {
  return daysBetween(meta.last_verified, date) >= STALE_DAYS;
}

function buildNotices(candidate: Candidate, amount_yen: number | null, date: string): Notice[] {
  const notices: Notice[] = [];
  for (const w of candidate.method.warnings ?? []) {
    // 金額の条件が付いた注意は、金額がそれを超えたときだけ出す
    if (w.amount_gt_yen === undefined || (amount_yen !== null && amount_yen > w.amount_gt_yen)) {
      notices.push({ kind: "method_warning", text: w.text });
    }
  }
  for (const c of candidate.components) {
    if (c.unverified) notices.push({ kind: "unverified", rule_id: c.rule_id, label: c.label });
    if (isStale(c.meta, date)) {
      notices.push({ kind: "stale", rule_id: c.rule_id, label: c.label, last_verified: c.meta.last_verified });
    }
    if (c.cap_note) notices.push({ kind: "cap", rule_id: c.rule_id, label: c.label, cap: c.cap_note });
  }
  return notices;
}

function buildRedemptions(rules: Rules, store: Store | null, amount_yen: number | null, date: string): RedemptionNotice[] {
  if (store === null) return [];
  const day = dayOfMonth(date);
  const notices: RedemptionNotice[] = [];
  for (const redemption of rules.redemptions) {
    if (!redemption.store_ids.includes(store.id)) continue;
    if (redemption.days_of_month && !redemption.days_of_month.includes(day)) continue;
    if (!isActive(redemption.meta, date)) continue;
    const cap = redemption.meta.cap;
    const cap_points = cap !== null && cap.unit === "point" && cap.period === "txn" ? cap.amount : null;
    const point_name = rules.points.find((p) => p.id === redemption.point_id)?.name ?? redemption.point_id;
    const notice: RedemptionNotice = {
      redemption,
      point_name,
      cap_points,
      use_points: null,
      covered_yen: null,
      remainder_yen: null,
    };
    if (amount_yen !== null && redemption.value_milliyen > 0) {
      // 全額を払うのに必要なポイント（切り上げ）。上限があればそこまで
      const needed_points = divCeil(amount_yen * MILLIYEN_PER_YEN, redemption.value_milliyen);
      const use_points = cap_points === null ? needed_points : Math.min(needed_points, cap_points);
      const covered_yen = Math.min(amount_yen, divFloor(use_points * redemption.value_milliyen, MILLIYEN_PER_YEN));
      notice.use_points = use_points;
      notice.covered_yen = covered_yen;
      notice.remainder_yen = amount_yen - covered_yen;
    }
    notices.push(notice);
  }
  return notices;
}

/** おすすめの支払い手段を判定する */
export function recommend(input: AdviseInput): Recommendation {
  const { rules, amount_yen, date } = input;
  const threshold_yen = input.annual_threshold_yen ?? 0;
  assertInt(threshold_yen, "annual_threshold_yen");
  const { store, candidates } = rankMethods(input);

  // 年間目標の状況
  const annual: AnnualAdvice[] = [];
  for (const card of rules.cards) {
    const target = card.annual_target;
    if (!target || !isActive(target.meta, date)) continue;
    const period = annualPeriod(date, target.period_start_month, target.period_start_day);
    const spent_yen = input.annual_spent_yen?.[card.id] ?? 0;
    annual.push({
      card_id: card.id,
      card_name: card.name,
      status: annualStatus({ target_yen: target.target_yen, spent_yen, date, period }),
    });
  }
  const behind_card_ids = new Set(annual.filter((a) => a.status.behind).map((a) => a.card_id));

  // ペース遅れのカードで払える最上位の候補が、1位との差が閾値以内なら1位にする
  let promotion: Promotion | null = null;
  const pace_alert_card_ids: string[] = [];
  const ordered = [...candidates];
  const top = ordered[0];
  const index = ordered.findIndex((c) => {
    const card_id = annualCardId(c.method);
    return card_id !== null && behind_card_ids.has(card_id);
  });
  const behind_candidate = index >= 0 ? ordered[index] : undefined;
  if (top && behind_candidate) {
    const card_id = annualCardId(behind_candidate.method) as string;
    if (index > 0) {
      const diff_milliyen =
        top.total_milliyen !== null && behind_candidate.total_milliyen !== null
          ? top.total_milliyen - behind_candidate.total_milliyen
          : null;
      if (diff_milliyen !== null && diff_milliyen <= threshold_yen * MILLIYEN_PER_YEN) {
        ordered.splice(index, 1);
        ordered.unshift(behind_candidate);
        promotion = { method_id: behind_candidate.method.id, card_id, diff_milliyen };
      } else {
        // 金額未入力、または差が閾値を超える場合は、順位を変えずに知らせるだけにする
        pace_alert_card_ids.push(card_id);
      }
    }
  }

  return {
    store,
    advices: ordered.map((candidate) => ({ candidate, notices: buildNotices(candidate, amount_yen, date) })),
    promotion,
    pace_alert_card_ids,
    annual,
    redemptions: buildRedemptions(rules, store, amount_yen, date),
    loyalty: store?.loyalty ?? [],
  };
}

/** ホーム画面に出す、ルールの期限と確認日の警告 */
export interface RuleAlert {
  kind: "expiring" | "stale";
  /** ルールの場所（例：cards/card_a/rewards/card_a_base） */
  where: string;
  label: string;
  /** expiring：valid_to / stale：last_verified */
  date: string;
  /** expiring：終了までの日数 / stale：確認からの経過日数 [日] */
  days: number;
}

/** 全ルールから「まもなく終了」「要再確認」を集める（期限切れのルールは対象外） */
export function ruleAlerts(rules: Rules, date: string): RuleAlert[] {
  const alerts: RuleAlert[] = [];
  const check = (where: string, label: string, meta: Meta): void => {
    if (!isActive(meta, date)) return;
    if (meta.valid_to !== null) {
      const days = daysBetween(date, meta.valid_to);
      if (days <= EXPIRING_DAYS) alerts.push({ kind: "expiring", where, label, date: meta.valid_to, days });
    }
    const since = daysBetween(meta.last_verified, date);
    if (since >= STALE_DAYS) alerts.push({ kind: "stale", where, label, date: meta.last_verified, days: since });
  };
  const checkRewards = (prefix: string, owner: string, rewards: readonly RewardRule[]): void => {
    for (const r of rewards) check(`${prefix}/rewards/${r.id}`, `${owner}：${r.label}`, r.meta);
  };
  for (const card of rules.cards) {
    checkRewards(`cards/${card.id}`, card.name, card.rewards);
    if (card.annual_target) check(`cards/${card.id}/annual_target`, `${card.name}：年間目標`, card.annual_target.meta);
  }
  for (const method of rules.methods) checkRewards(`methods/${method.id}`, method.label, method.rewards ?? []);
  for (const group of rules.store_groups) check(`store_groups/${group.id}`, group.name, group.meta);
  for (const redemption of rules.redemptions) check(`redemptions/${redemption.id}`, redemption.text, redemption.meta);
  return alerts;
}

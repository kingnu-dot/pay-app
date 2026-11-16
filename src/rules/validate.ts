// ルール JSON の検証。Schema（構造）と整合性（ID の重複・参照切れ・日付の前後）の両方を確認する

import { toEpochDay } from "../engine/dates";
import validateSchema from "../generated/validate-rules.js";
import type { Meta, RewardRule, Rules } from "./types";

export type ParseResult = { ok: true; rules: Rules } | { ok: false; errors: string[] };

/** 表示するエラーの最大件数 */
const MAX_ERRORS = 20;

/**
 * 計算単位あたりの還元額（付与量 × 倍率 × 評価額）の上限 [1/1000 円]。
 * 金額の上限（10 億円）と掛けても整数演算が安全な範囲（2^53 未満）に収まる値にしている
 */
const MAX_PER_UNIT_MILLIYEN = 1_000_000;

/** 検証して、合格ならルールを返す。不合格ならエラー箇所の一覧を返す */
export function parseRules(data: unknown): ParseResult {
  if (!validateSchema(data)) {
    const errors = (validateSchema.errors ?? []).map(
      (e) => `${e.instancePath || "/"}: ${e.message ?? e.keyword}`,
    );
    return { ok: false, errors: [...new Set(errors)].slice(0, MAX_ERRORS) };
  }
  const rules = data as Rules;
  const errors = checkIntegrity(rules);
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, MAX_ERRORS) };
  return { ok: true, rules };
}

/** Schema では表せない整合性の検査 */
export function checkIntegrity(rules: Rules): string[] {
  const errors: string[] = [];

  // 種類ごとに ID の重複を調べ、ID の集合を返す
  const collectIds = (kind: string, ids: string[]): Set<string> => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) errors.push(`${kind} の id が重複しています: ${id}`);
      seen.add(id);
    }
    return seen;
  };
  const requireRef = (where: string, kind: string, known: Set<string>, id: string): void => {
    if (!known.has(id)) errors.push(`${where}: 存在しない ${kind} を参照しています: ${id}`);
  };
  // Schema の書式検査は 2/31 のような日付を通すので、暦に存在するかをここで確かめる
  const checkDate = (where: string, date: string | null): void => {
    if (date === null) return;
    try {
      toEpochDay(date);
    } catch {
      errors.push(`${where}: 存在しない日付です: ${date}`);
    }
  };
  const checkMeta = (where: string, meta: Meta): void => {
    checkDate(`${where}/last_verified`, meta.last_verified);
    checkDate(`${where}/valid_from`, meta.valid_from);
    checkDate(`${where}/valid_to`, meta.valid_to);
    if (meta.valid_from !== null && meta.valid_to !== null && meta.valid_from > meta.valid_to) {
      errors.push(`${where}: valid_from が valid_to より後です`);
    }
  };

  checkDate("updated_at", rules.updated_at);
  const pointValues = new Map(rules.points.map((p) => [p.id, p.value_milliyen]));
  const pointIds = collectIds("points", rules.points.map((p) => p.id));
  const cardIds = collectIds("cards", rules.cards.map((c) => c.id));
  const storeIds = collectIds("stores", rules.stores.map((s) => s.id));
  const groupIds = collectIds("store_groups", rules.store_groups.map((g) => g.id));
  const methodIds = collectIds("methods", rules.methods.map((m) => m.id));
  collectIds("redemptions", rules.redemptions.map((r) => r.id));

  const allRewards: Array<{ where: string; rule: RewardRule }> = [];
  for (const card of rules.cards) {
    for (const rule of card.rewards) allRewards.push({ where: `cards/${card.id}/rewards/${rule.id}`, rule });
    if (card.annual_target) checkMeta(`cards/${card.id}/annual_target`, card.annual_target.meta);
  }
  for (const method of rules.methods) {
    for (const rule of method.rewards ?? []) allRewards.push({ where: `methods/${method.id}/rewards/${rule.id}`, rule });
  }
  collectIds("還元ルール", allRewards.map((r) => r.rule.id));

  for (const { where, rule } of allRewards) {
    requireRef(where, "points", pointIds, rule.point_id);
    const per_unit_milliyen = rule.points_per_unit * (rule.multiplier ?? 1) * (pointValues.get(rule.point_id) ?? 0);
    if (per_unit_milliyen > MAX_PER_UNIT_MILLIYEN) {
      errors.push(`${where}: 計算単位あたりの還元額が大きすぎます（${per_unit_milliyen / 1000} 円）`);
    }
    for (const id of rule.applies.store_group_ids ?? []) requireRef(where, "store_groups", groupIds, id);
    for (const id of rule.applies.store_ids ?? []) requireRef(where, "stores", storeIds, id);
    for (const id of rule.applies.exclude_store_ids ?? []) requireRef(where, "stores", storeIds, id);
    checkMeta(where, rule.meta);
  }

  for (const method of rules.methods) {
    const where = `methods/${method.id}`;
    if (method.card_id !== null) requireRef(where, "cards", cardIds, method.card_id);
    if (method.funding && method.funding.card_id !== null) requireRef(where, "cards", cardIds, method.funding.card_id);
    for (const id of method.only_store_group_ids ?? []) requireRef(where, "store_groups", groupIds, id);
    if (method.card_id !== null && method.funding) {
      errors.push(`${where}: card_id と funding は同時に指定できません`);
    }
  }

  for (const store of rules.stores) {
    for (const id of store.unusable_method_ids ?? []) requireRef(`stores/${store.id}`, "methods", methodIds, id);
  }

  for (const group of rules.store_groups) {
    const where = `store_groups/${group.id}`;
    for (const id of group.store_ids) requireRef(where, "stores", storeIds, id);
    checkMeta(where, group.meta);
  }

  collectIds("services", (rules.services ?? []).map((s) => s.id));
  for (const service of rules.services ?? []) {
    const where = `services/${service.id}`;
    for (const id of service.store_ids ?? []) requireRef(where, "stores", storeIds, id);
    if (!service.app && service.search_url_template === undefined) {
      errors.push(`${where}: app と search_url_template の少なくとも一方が必要です`);
    }
  }

  for (const redemption of rules.redemptions) {
    const where = `redemptions/${redemption.id}`;
    requireRef(where, "points", pointIds, redemption.point_id);
    for (const id of redemption.store_ids) requireRef(where, "stores", storeIds, id);
    checkMeta(where, redemption.meta);
  }

  return errors;
}

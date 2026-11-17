// ルールの変更点を、画面に出せる文章の一覧にする（ルールが更新されたときの通知用）

import type { Meta, Point, Redemption, RewardRule, Rules, Store, StoreGroup } from "./types";

export interface RuleChange {
  /** added：追加 / removed：削除 / changed：変更 */
  kind: "added" | "removed" | "changed";
  text: string;
}

/** 計算単位あたりの付与量を「200円ごとに13pt」の形にする */
function rateText(rule: RewardRule, points: ReadonlyMap<string, Point>): string {
  const point = points.get(rule.point_id)?.name ?? rule.point_id;
  const multiplier = rule.multiplier && rule.multiplier !== 1 ? `（×${rule.multiplier}）` : "";
  return `${rule.unit_yen.toLocaleString("ja-JP")}円ごとに${rule.points_per_unit}${point}${multiplier}`;
}

const periodText = (meta: Pick<Meta, "valid_from" | "valid_to">): string =>
  `${meta.valid_from ?? "指定なし"}〜${meta.valid_to ?? "指定なし"}`;

/** id で突き合わせて、追加・削除・共通の組を返す */
function byId<T extends { id: string }>(before: readonly T[], after: readonly T[]) {
  const old_map = new Map(before.map((x) => [x.id, x]));
  const new_map = new Map(after.map((x) => [x.id, x]));
  return {
    added: after.filter((x) => !old_map.has(x.id)),
    removed: before.filter((x) => !new_map.has(x.id)),
    common: after.filter((x) => old_map.has(x.id)).map((x) => [old_map.get(x.id) as T, x] as const),
  };
}

/** 変更前と変更後のルールを比べて、変更点の一覧を返す */
export function diffRules(before: Rules, after: Rules): RuleChange[] {
  const changes: RuleChange[] = [];
  const points_after = new Map(after.points.map((p) => [p.id, p]));
  const points_before = new Map(before.points.map((p) => [p.id, p]));
  const storeName = (id: string): string =>
    (after.stores.find((s) => s.id === id) ?? before.stores.find((s) => s.id === id))?.name ?? id;

  // ポイントの評価額
  for (const [b, a] of byId<Point>(before.points, after.points).common) {
    if (b.value_milliyen !== a.value_milliyen) {
      changes.push({ kind: "changed", text: `${a.name}の評価額：${b.value_milliyen / 1000}円 → ${a.value_milliyen / 1000}円` });
    }
  }

  // 還元ルール（カードと支払い手段）
  const rewardsOf = (rules: Rules): Array<RewardRule & { owner: string }> => [
    ...rules.cards.flatMap((c) => c.rewards.map((r) => ({ ...r, owner: c.name }))),
    ...rules.methods.flatMap((m) => (m.rewards ?? []).map((r) => ({ ...r, owner: m.label }))),
  ];
  const rewards = byId(rewardsOf(before), rewardsOf(after));
  for (const r of rewards.added) {
    changes.push({ kind: "added", text: `${r.owner}：${r.label}（${rateText(r, points_after)}、有効 ${periodText(r.meta)}）` });
  }
  for (const r of rewards.removed) changes.push({ kind: "removed", text: `${r.owner}：${r.label}` });
  for (const [b, a] of rewards.common) {
    const name = `${a.owner}：${a.label}`;
    const old_rate = rateText(b, points_before);
    const new_rate = rateText(a, points_after);
    if (old_rate !== new_rate || b.rounding !== a.rounding || b.scope !== a.scope) {
      changes.push({ kind: "changed", text: `${name}：${old_rate} → ${new_rate}` });
    }
    if (b.meta.valid_from !== a.meta.valid_from || b.meta.valid_to !== a.meta.valid_to) {
      changes.push({ kind: "changed", text: `${name}：有効期間 ${periodText(b.meta)} → ${periodText(a.meta)}` });
    }
    if (b.label !== a.label) changes.push({ kind: "changed", text: `${a.owner}：名前「${b.label}」→「${a.label}」` });
  }

  // 店舗
  const stores = byId<Store>(before.stores, after.stores);
  for (const s of stores.added) changes.push({ kind: "added", text: `店舗：${s.name}` });
  for (const s of stores.removed) changes.push({ kind: "removed", text: `店舗：${s.name}` });

  // 対象店の一覧（店舗グループ）の入れ替え
  const groups = byId<StoreGroup>(before.store_groups, after.store_groups);
  for (const g of groups.added) changes.push({ kind: "added", text: `${g.name}（${g.store_ids.map(storeName).join("、")}）` });
  for (const g of groups.removed) changes.push({ kind: "removed", text: g.name });
  for (const [b, a] of groups.common) {
    const joined = a.store_ids.filter((id) => !b.store_ids.includes(id));
    const left = b.store_ids.filter((id) => !a.store_ids.includes(id));
    if (joined.length > 0) changes.push({ kind: "added", text: `${a.name}に追加：${joined.map(storeName).join("、")}` });
    if (left.length > 0) changes.push({ kind: "removed", text: `${a.name}から削除：${left.map(storeName).join("、")}` });
  }

  // ポイント利用の案内
  const redemptions = byId<Redemption>(before.redemptions, after.redemptions);
  for (const r of redemptions.added) changes.push({ kind: "added", text: `案内：${r.text}` });
  for (const r of redemptions.removed) changes.push({ kind: "removed", text: `案内：${r.text}` });
  for (const [b, a] of redemptions.common) {
    if (b.value_milliyen !== a.value_milliyen || JSON.stringify(b.meta.cap) !== JSON.stringify(a.meta.cap)) {
      changes.push({ kind: "changed", text: `案内「${a.text}」の価値または上限` });
    }
    if (b.meta.valid_from !== a.meta.valid_from || b.meta.valid_to !== a.meta.valid_to) {
      changes.push({ kind: "changed", text: `案内「${a.text}」：有効期間 ${periodText(b.meta)} → ${periodText(a.meta)}` });
    }
  }

  // クーポン・優待の確認先
  const services = byId(before.services ?? [], after.services ?? []);
  for (const s of services.added) changes.push({ kind: "added", text: `サービス：${s.name}` });
  for (const s of services.removed) changes.push({ kind: "removed", text: `サービス：${s.name}` });

  return changes;
}

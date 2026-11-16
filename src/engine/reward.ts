// 還元ルール1件の付与量の計算

import { assertInt, divFloor, divRound } from "./money";
import type { RewardRule } from "../rules/types";

/** 計算に使う項目だけを取り出した型（テストで最小限のデータを渡せるようにする） */
export type RewardFormula = Pick<RewardRule, "unit_yen" | "points_per_unit" | "rounding" | "multiplier">;

/**
 * 1回の利用で実際に付与されるポイント数 [ポイント]。
 * 計算順序：(1) 金額 ÷ unit_yen を端数処理 (2) points_per_unit を掛ける (3) multiplier を掛ける。
 * 掛け算を端数処理の後に行うので、「四捨五入してから 2 倍」のような公式の計算と一致する。
 */
export function pointsPerTxn(rule: RewardFormula, amount_yen: number): number {
  assertInt(amount_yen, "amount_yen");
  if (amount_yen < 0) throw new RangeError(`amount_yen は 0 以上である必要があります: ${amount_yen}`);
  const units =
    rule.rounding === "round" ? divRound(amount_yen, rule.unit_yen) : divFloor(amount_yen, rule.unit_yen);
  return units * rule.points_per_unit * (rule.multiplier ?? 1);
}

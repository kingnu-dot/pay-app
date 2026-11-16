// 利用額の記録から、年間目標の累計を求める

import type { AnnualPeriod } from "./annual";
import { assertInt } from "./money";

/** 集計に使う項目（保存している記録の一部） */
export interface SpendLike {
  date: string;
  amount_yen: number;
  annual_card_id: string | null;
}

/** 期間内に、そのカードの年間利用額として計上された合計 [円]（両端の日を含む） */
export function sumAnnualSpent(entries: readonly SpendLike[], card_id: string, period: AnnualPeriod): number {
  let total_yen = 0;
  for (const e of entries) {
    if (e.annual_card_id === card_id && e.date >= period.start && e.date <= period.end) total_yen += e.amount_yen;
  }
  return total_yen;
}

/**
 * 累計を上書き入力したときに記録する差額 [円]。
 * 履歴を消さずに「入力した累計 − 記録の合計」を補正として足す（負の値にもなる）
 */
export function adjustmentFor(recorded_total_yen: number, entered_total_yen: number): number {
  assertInt(recorded_total_yen, "recorded_total_yen");
  assertInt(entered_total_yen, "entered_total_yen");
  if (entered_total_yen < 0) throw new RangeError(`累計は 0 以上で入力してください: ${entered_total_yen}`);
  return entered_total_yen - recorded_total_yen;
}

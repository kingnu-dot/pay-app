// 年間利用額の目標：集計期間と達成ペースの計算

import { addDays, daysBetween, formatDate, yearOf } from "./dates";
import { assertInt, divCeil, divFloor } from "./money";

/** 集計期間（両端を含む） */
export interface AnnualPeriod {
  start: string;
  end: string;
}

export interface AnnualStatus {
  period: AnnualPeriod;
  target_yen: number;
  /** 今期の累計（集計対象の決済だけ）[円] */
  spent_yen: number;
  /** 目標までの残額 [円]（達成済みなら 0） */
  remaining_yen: number;
  /** 期間の日数 [日] */
  total_days: number;
  /** 期間の開始から経過した日数 [日]（初日は 0） */
  elapsed_days: number;
  /** 今日を含む残り日数 [日] */
  remaining_days: number;
  /** 残り日数で均等に使う場合の 1日あたり必要額 [円]（切り上げ） */
  required_per_day_yen: number;
  /** 日割りの直線で見た、今日までに使っているべき額 [円]（表示用。1 円未満は切り捨て） */
  pace_yen: number;
  /** 累計が日割りの直線（目標 × 経過日数 ÷ 期間日数。切り捨てない値）を下回っているか */
  behind: boolean;
  achieved: boolean;
}

/** date を含む集計期間を求める。開始日は毎年 start_month 月 start_day 日 */
export function annualPeriod(date: string, start_month: number, start_day: number): AnnualPeriod {
  const year = yearOf(date);
  const this_year_start = formatDate(year, start_month, start_day);
  const start_year = date >= this_year_start ? year : year - 1;
  return {
    start: formatDate(start_year, start_month, start_day),
    end: addDays(formatDate(start_year + 1, start_month, start_day), -1),
  };
}

/** 達成状況を計算する */
export function annualStatus(args: {
  target_yen: number;
  spent_yen: number;
  date: string;
  period: AnnualPeriod;
}): AnnualStatus {
  const { target_yen, spent_yen, date, period } = args;
  assertInt(target_yen, "target_yen");
  assertInt(spent_yen, "spent_yen");
  if (target_yen <= 0) throw new RangeError(`target_yen は 1 以上である必要があります: ${target_yen}`);
  if (date < period.start || date > period.end) {
    throw new RangeError(`判定日が集計期間の外です: ${date}（${period.start}〜${period.end}）`);
  }
  // 補正入力で累計が負になっても計算が止まらないよう、0 として扱う
  const counted_yen = Math.max(spent_yen, 0);
  const total_days = daysBetween(period.start, period.end) + 1;
  const elapsed_days = daysBetween(period.start, date);
  const remaining_days = total_days - elapsed_days;
  const remaining_yen = Math.max(target_yen - counted_yen, 0);
  const pace_yen = divFloor(target_yen * elapsed_days, total_days);
  const achieved = counted_yen >= target_yen;
  return {
    period,
    target_yen,
    spent_yen,
    remaining_yen,
    total_days,
    elapsed_days,
    remaining_days,
    required_per_day_yen: divCeil(remaining_yen, remaining_days),
    pace_yen,
    // 切り捨てた pace_yen と比べると 1 円ずれるので、割り算をせず整数の掛け算どうしで比べる
    behind: !achieved && counted_yen * total_days < target_yen * elapsed_days,
    achieved,
  };
}

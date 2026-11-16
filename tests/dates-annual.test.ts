import { describe, expect, it } from "vitest";
import { annualPeriod, annualStatus } from "../src/engine/annual";
import { addDays, daysBetween, toEpochDay, toJstDate } from "../src/engine/dates";
import { divCeil } from "../src/engine/money";

describe("toJstDate：Asia/Tokyo の暦日", () => {
  it("UTC 15:00 を境に日付が変わる（端末のタイムゾーンに依存しない）", () => {
    expect(toJstDate(new Date("2026-03-31T14:59:59Z"))).toBe("2026-03-31");
    expect(toJstDate(new Date("2026-03-31T15:00:00Z"))).toBe("2026-04-01");
  });

  it("年をまたぐ時刻も正しく変換する", () => {
    expect(toJstDate(new Date("2025-12-31T15:00:00Z"))).toBe("2026-01-01");
  });
});

describe("日付の計算", () => {
  it("日数の差と加算", () => {
    expect(daysBetween("2026-01-10", "2026-01-10")).toBe(0);
    expect(daysBetween("2025-04-01", "2026-01-10")).toBe(284);
    expect(daysBetween("2026-01-10", "2025-04-01")).toBe(-284);
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29"); // うるう年
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("存在しない日付や書式違いは例外にする", () => {
    expect(() => toEpochDay("2026-02-30")).toThrow(RangeError);
    expect(() => toEpochDay("2026/02/01")).toThrow(RangeError);
  });
});

describe("divCeil（切り上げ）", () => {
  it("割り切れるときはそのまま、余りがあれば 1 増える", () => {
    expect(divCeil(200, 100)).toBe(2);
    expect(divCeil(201, 100)).toBe(3);
    expect(divCeil(0, 100)).toBe(0);
  });
});

describe("annualPeriod：集計期間（開始日 4/1 の架空カード）", () => {
  it("期間の切替：開始日の前日は前の期、開始日から新しい期", () => {
    expect(annualPeriod("2026-03-31", 4, 1)).toEqual({ start: "2025-04-01", end: "2026-03-31" });
    expect(annualPeriod("2026-04-01", 4, 1)).toEqual({ start: "2026-04-01", end: "2027-03-31" });
  });

  it("年の途中の日付は、その年の開始日からの期に入る", () => {
    expect(annualPeriod("2026-01-10", 4, 1)).toEqual({ start: "2025-04-01", end: "2026-03-31" });
    expect(annualPeriod("2026-12-31", 4, 1)).toEqual({ start: "2026-04-01", end: "2027-03-31" });
  });
});

describe("annualStatus：達成ペース（目標 500,000 円）", () => {
  const period = { start: "2025-04-01", end: "2026-03-31" };
  const at = (spent_yen: number, date = "2026-01-10") => annualStatus({ target_yen: 500_000, spent_yen, date, period });

  it("残額・残り日数・1日あたり必要額を計算する", () => {
    const s = at(300_000);
    expect(s.total_days).toBe(365);
    expect(s.elapsed_days).toBe(284);
    expect(s.remaining_days).toBe(81); // 今日を含む
    expect(s.remaining_yen).toBe(200_000);
    expect(s.required_per_day_yen).toBe(2_470); // 200,000 ÷ 81 = 2,469.1… を切り上げ
    expect(s.pace_yen).toBe(389_041); // 500,000 × 284 ÷ 365 を切り捨て
  });

  it("累計が日割りの直線を下回ると遅れ、ちょうどなら遅れではない", () => {
    expect(at(389_040).behind).toBe(true);
    expect(at(389_041).behind).toBe(false);
  });

  it("期間の初日はペースが 0 なので、累計 0 でも遅れではない", () => {
    const s = at(0, "2025-04-01");
    expect(s.pace_yen).toBe(0);
    expect(s.behind).toBe(false);
    expect(s.remaining_days).toBe(365);
  });

  it("期間の最終日は残り 1 日で、残額がそのまま必要額になる", () => {
    const s = at(480_000, "2026-03-31");
    expect(s.remaining_days).toBe(1);
    expect(s.required_per_day_yen).toBe(20_000);
  });

  it("達成済みなら残額 0 で、遅れにならない", () => {
    const s = at(500_000);
    expect(s).toMatchObject({ achieved: true, behind: false, remaining_yen: 0, required_per_day_yen: 0 });
  });

  it("うるう年を含む期間は 366 日", () => {
    const leap = { start: "2027-04-01", end: "2028-03-31" };
    expect(annualStatus({ target_yen: 500_000, spent_yen: 0, date: "2027-04-01", period: leap }).total_days).toBe(366);
  });

  it("判定日が期間の外なら例外にする", () => {
    expect(() => at(0, "2026-04-01")).toThrow(RangeError);
  });
});

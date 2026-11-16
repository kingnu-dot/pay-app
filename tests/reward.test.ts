import { describe, expect, it } from "vitest";
import { pointsPerTxn, type RewardFormula } from "../src/engine/reward";

// 架空のカード：100 円単位で四捨五入して 1 ポイント、提携店ではその後に 2 倍
const base: RewardFormula = { unit_yen: 100, points_per_unit: 1, rounding: "round" };
const doubled: RewardFormula = { ...base, multiplier: 2 };

describe("pointsPerTxn：四捨五入の後に倍率を掛ける", () => {
  it("150 円 → 四捨五入で 2、2 倍して 4 ポイント", () => {
    expect(pointsPerTxn(doubled, 150)).toBe(4);
  });

  it("349 円 → 四捨五入で 3、2 倍して 6 ポイント", () => {
    expect(pointsPerTxn(doubled, 349)).toBe(6);
  });

  it("「2 倍してから四捨五入」（150 × 2 ÷ 100 = 3）とは結果が異なる", () => {
    const multiply_then_round = Math.round((150 * 2) / 100);
    expect(multiply_then_round).toBe(3);
    expect(pointsPerTxn(doubled, 150)).not.toBe(multiply_then_round);
  });

  it("倍率を points_per_unit 側に書いても、端数処理の後に掛かる", () => {
    const as_points: RewardFormula = { unit_yen: 100, points_per_unit: 2, rounding: "round" };
    expect(pointsPerTxn(as_points, 150)).toBe(4);
    expect(pointsPerTxn(as_points, 349)).toBe(6);
  });

  it("四捨五入の境目：49 円は 0、50 円は倍率込みで 2", () => {
    expect(pointsPerTxn(doubled, 49)).toBe(0);
    expect(pointsPerTxn(doubled, 50)).toBe(2);
    expect(pointsPerTxn(base, 149)).toBe(1);
    expect(pointsPerTxn(base, 150)).toBe(2);
  });
});

describe("pointsPerTxn：切り捨て", () => {
  // 架空の上乗せ：300 円ごとに 7 ポイント（切り捨て）
  const bonus: RewardFormula = { unit_yen: 300, points_per_unit: 7, rounding: "floor" };

  it("単位未満は 0、単位ちょうどで付与される", () => {
    expect(pointsPerTxn(bonus, 299)).toBe(0);
    expect(pointsPerTxn(bonus, 300)).toBe(7);
    expect(pointsPerTxn(bonus, 1000)).toBe(21);
  });

  it("金額 0 円は 0 ポイント", () => {
    expect(pointsPerTxn(bonus, 0)).toBe(0);
  });
});

describe("pointsPerTxn：入力の検査", () => {
  it("負の金額や整数でない金額は例外にする", () => {
    expect(() => pointsPerTxn(base, -1)).toThrow(RangeError);
    expect(() => pointsPerTxn(base, 10.5)).toThrow(RangeError);
  });
});

import { describe, expect, it } from "vitest";
import { pointsPerTxn, type RewardFormula } from "../src/engine/reward";

// 架空のカード：200 円単位で四捨五入して 1 ポイント、提携店ではその後に 3 倍
const base: RewardFormula = { unit_yen: 200, points_per_unit: 1, rounding: "round" };
const tripled: RewardFormula = { ...base, multiplier: 3 };

describe("pointsPerTxn：四捨五入の後に倍率を掛ける", () => {
  it("300 円 → 四捨五入で 2、3 倍して 6 ポイント", () => {
    expect(pointsPerTxn(tripled, 300)).toBe(6);
  });

  it("699 円 → 四捨五入で 3、3 倍して 9 ポイント", () => {
    expect(pointsPerTxn(tripled, 699)).toBe(9);
  });

  it("「3 倍してから四捨五入」（300 × 3 ÷ 200 = 4.5 → 5）とは結果が異なる", () => {
    const multiply_then_round = Math.round((300 * 3) / 200);
    expect(multiply_then_round).toBe(5);
    expect(pointsPerTxn(tripled, 300)).not.toBe(multiply_then_round);
  });

  it("倍率を points_per_unit 側に書いても、端数処理の後に掛かる", () => {
    const as_points: RewardFormula = { unit_yen: 200, points_per_unit: 3, rounding: "round" };
    expect(pointsPerTxn(as_points, 300)).toBe(6);
    expect(pointsPerTxn(as_points, 699)).toBe(9);
  });

  it("四捨五入の境目：99 円は 0、100 円は倍率込みで 3", () => {
    expect(pointsPerTxn(tripled, 99)).toBe(0);
    expect(pointsPerTxn(tripled, 100)).toBe(3);
    expect(pointsPerTxn(base, 299)).toBe(1);
    expect(pointsPerTxn(base, 300)).toBe(2);
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

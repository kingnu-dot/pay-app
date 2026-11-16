import { describe, expect, it } from "vitest";
import { divFloor, divRound } from "../src/engine/money";

describe("divFloor（切り捨て）", () => {
  it("単位未満は 0、単位ちょうどで 1 になる", () => {
    expect(divFloor(199, 200)).toBe(0);
    expect(divFloor(200, 200)).toBe(1);
    expect(divFloor(1000, 200)).toBe(5);
  });
});

describe("divRound（四捨五入）", () => {
  it("0.5 未満は切り捨て、0.5 以上は切り上げる", () => {
    expect(divRound(49, 100)).toBe(0);
    expect(divRound(50, 100)).toBe(1);
    expect(divRound(149, 100)).toBe(1);
    expect(divRound(150, 100)).toBe(2);
  });
});

describe("入力の検査", () => {
  it("整数でない値や負の値は例外にする", () => {
    expect(() => divFloor(1.5, 2)).toThrow(RangeError);
    expect(() => divFloor(-1, 2)).toThrow(RangeError);
    expect(() => divRound(1, 0)).toThrow(RangeError);
  });
});

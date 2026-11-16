// 金額の整数演算。浮動小数の誤差を避けるため、円換算額は 1/1000 円（ミリ円）の整数で扱う

/** 1 円あたりのミリ円 */
export const MILLIYEN_PER_YEN = 1000;

/** 整数であることを確認する。整数でなければ例外（ルールや入力の不備を早期に見つけるため） */
export function assertInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} は整数である必要があります: ${value}`);
  }
}

/** 0 以上の整数どうしの切り捨て除算 */
export function divFloor(numerator: number, denominator: number): number {
  assertInt(numerator, "numerator");
  assertInt(denominator, "denominator");
  if (numerator < 0 || denominator <= 0) {
    throw new RangeError(`divFloor の引数が範囲外です: ${numerator} / ${denominator}`);
  }
  return (numerator - (numerator % denominator)) / denominator;
}

/** 0 以上の整数どうしの四捨五入除算（小数第1位を四捨五入。0.5 は切り上げ） */
export function divRound(numerator: number, denominator: number): number {
  assertInt(numerator, "numerator");
  assertInt(denominator, "denominator");
  if (numerator < 0 || denominator <= 0) {
    throw new RangeError(`divRound の引数が範囲外です: ${numerator} / ${denominator}`);
  }
  return divFloor(2 * numerator + denominator, 2 * denominator);
}

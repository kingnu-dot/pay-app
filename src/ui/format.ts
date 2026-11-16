// 表示用の整形（計算は整数のまま行い、ここで文字列にする）

import { MAX_AMOUNT_YEN } from "../engine/recommend";
import type { Cap } from "../rules/types";

const group = (n: number): string => n.toLocaleString("ja-JP");

/** 円（整数）を「1,000円」の形にする */
export function formatYen(yen: number): string {
  return `${group(yen)}円`;
}

/** 1/1000 円を「105円」「10.5円」の形にする（0.1 円未満は切り捨て） */
export function formatMilliyen(milliyen: number): string {
  const sign = milliyen < 0 ? "-" : "";
  const tenths = Math.floor(Math.abs(milliyen) / 100);
  const whole = Math.floor(tenths / 10);
  const fraction = tenths % 10;
  return `${sign}${group(whole)}${fraction === 0 ? "" : `.${fraction}`}円`;
}

/** ppm を「10.5%」の形にする（0.01% 未満は切り捨て。末尾の 0 は省く） */
export function formatRate(ppm: number): string {
  const hundredths = Math.floor(ppm / 100);
  const whole = Math.floor(hundredths / 100);
  const fraction = String(hundredths % 100).padStart(2, "0").replace(/0+$/, "");
  return `${whole}${fraction === "" ? "" : `.${fraction}`}%`;
}

/** 上限を「1会計あたり 3,000 ポイントまで」の形にする */
export function formatCap(cap: Cap): string {
  const period = { txn: "1会計あたり", day: "1日あたり", month: "月間", year: "年間" }[cap.period];
  const unit = cap.unit === "point" ? "ポイント" : "円";
  return `${period} ${group(cap.amount)} ${unit}まで`;
}

/** YYYY-MM-DD を「2026/1/10」の形にする */
export function formatDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return `${y}/${m}/${d}`;
}

export type AmountInput = { ok: true; amount_yen: number | null } | { ok: false; message: string };

/** 金額の入力を読み取る。空欄は「未入力」。全角数字や桁区切りのカンマも受け付ける */
export function parseAmount(text: string): AmountInput {
  const cleaned = text.normalize("NFKC").replace(/[,\s円¥]/g, "");
  if (cleaned === "") return { ok: true, amount_yen: null };
  if (!/^\d{1,10}$/.test(cleaned)) return { ok: false, message: "金額は数字で入力してください" };
  const amount_yen = Number(cleaned);
  if (amount_yen > MAX_AMOUNT_YEN) return { ok: false, message: "金額が大きすぎます" };
  return { ok: true, amount_yen };
}

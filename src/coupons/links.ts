// クーポン・優待の画面から開くリンクを作る（カレンダー登録、店名検索、アプリの起動）

import { addDays } from "../engine/dates";
import type { Coupon } from "./coupons";

/** カレンダーの予定を、期限の何日前に置くか [日] */
export const CALENDAR_LEAD_DAYS = 3;

const compact = (date: string): string => date.replaceAll("-", "");
const monthDay = (date: string): string => {
  const [, m, d] = date.split("-").map(Number);
  return `${m}/${d}`;
};

/** カレンダーの予定を置く日。期限の 3 日前。すでに過ぎていれば今日 */
export function calendarDate(expires: string, today: string): string {
  const lead = addDays(expires, -CALENDAR_LEAD_DAYS);
  return lead < today ? today : lead;
}

/**
 * Google カレンダーの予定作成ページを開く URL（終日の予定。保存は利用者が自分で行う）。
 * 期限のないクーポンは予定にできないので null
 */
export function calendarUrl(coupon: Coupon, today: string, store_names: readonly string[]): string | null {
  if (coupon.expires === null) return null;
  const date = calendarDate(coupon.expires, today);
  const details = [
    `期限：${coupon.expires}`,
    coupon.conditions ? `条件：${coupon.conditions}` : "",
    store_names.length > 0 ? `対象店舗：${store_names.join("、")}` : "",
    coupon.memo ? `メモ：${coupon.memo}` : "",
  ].filter((line) => line !== "");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: `【クーポン期限 ${monthDay(coupon.expires)}】${coupon.title}`,
    // 終日の予定は「開始日/終了日の翌日」で指定する
    dates: `${compact(date)}/${compact(addDays(date, 1))}`,
    details: details.join("\n"),
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** 店名で検索するページの URL（ひな形の {query} を店名に置き換える） */
export function searchUrl(template: string, store_name: string): string {
  return template.replace("{query}", encodeURIComponent(store_name));
}

/** Play ストアのアプリのページ */
export function playStoreUrl(android_package: string): string {
  return `https://play.google.com/store/apps/details?id=${encodeURIComponent(android_package)}`;
}

/**
 * Android でアプリを開くための intent リンク。
 * - open_url があれば、その URL をそのアプリで開く
 * - なければ、パッケージ名だけでアプリの起動を試みる
 * アプリが入っていない、または開けない場合は Play ストアのページへ進む
 */
export function appIntentUrl(app: { android_package: string; open_url?: string }): string {
  const fallback = `S.browser_fallback_url=${encodeURIComponent(playStoreUrl(app.android_package))}`;
  if (app.open_url !== undefined) {
    const url = new URL(app.open_url);
    return `intent://${url.host}${url.pathname}${url.search}#Intent;scheme=https;package=${app.android_package};${fallback};end`;
  }
  return `intent://#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=${app.android_package};${fallback};end`;
}

/** 利用者が入力した URL が、開いてよい形（https のみ）か */
export function isSafeHttpsUrl(text: string): boolean {
  try {
    return new URL(text).protocol === "https:" && !/\s/.test(text);
  } catch {
    return false;
  }
}

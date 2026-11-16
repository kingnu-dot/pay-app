// クーポン・優待（手動で登録したもの）と、利用中のサービスの判定
// クーポンの中身を外部から取得することはしない。端末内に登録したものだけを扱う

import { daysBetween, toEpochDay } from "../engine/dates";
import type { Service } from "../rules/types";
import type { Settings } from "../settings/settings";

export interface Coupon {
  /** 端末内での識別子（c1, c2, …） */
  id: string;
  title: string;
  /** 期限（YYYY-MM-DD、その日まで使える）。期限のない優待は null */
  expires: string | null;
  /** 利用条件（例：1,000 円以上で 100 円引き） */
  conditions: string;
  /** 対象の店舗。空なら店舗を限定しない */
  store_ids: string[];
  /** 関連するサービス（アプリなど）。なければ null */
  service_id: string | null;
  memo: string;
  /** 使用済みか */
  used: boolean;
  /** 登録した時刻（ISO 8601） */
  created_at: string;
}

/** 期限がこの日数以内のクーポンを、ホーム画面の上部に出す [日] */
export const EXPIRING_SOON_DAYS = 7;
export const MAX_TITLE_LENGTH = 100;
export const MAX_TEXT_LENGTH = 500;
const MAX_COUPONS = 2000;
const COUPON_ID = /^c[1-9][0-9]{0,8}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isValidDate(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    toEpochDay(v);
    return true;
  } catch {
    return false;
  }
}

/** 保存されていた値やバックアップからクーポン1件を読み取る。形式が合わなければ null */
export function parseCoupon(v: unknown): Coupon | null {
  if (!isRecord(v)) return null;
  const { id, title, expires, conditions, store_ids, service_id, memo, used, created_at } = v;
  if (typeof id !== "string" || !COUPON_ID.test(id)) return null;
  if (typeof title !== "string" || title.trim() === "" || title.length > MAX_TITLE_LENGTH) return null;
  if (expires !== null && !isValidDate(expires)) return null;
  if (typeof conditions !== "string" || conditions.length > MAX_TEXT_LENGTH) return null;
  if (!Array.isArray(store_ids) || !store_ids.every((s) => typeof s === "string" && s !== "" && s.length <= 100)) return null;
  if (service_id !== null && (typeof service_id !== "string" || service_id === "" || service_id.length > 100)) return null;
  if (typeof memo !== "string" || memo.length > MAX_TEXT_LENGTH) return null;
  if (typeof used !== "boolean") return null;
  if (typeof created_at !== "string" || Number.isNaN(Date.parse(created_at))) return null;
  return {
    id,
    title: title.trim(),
    expires,
    conditions,
    store_ids: [...new Set(store_ids as string[])],
    service_id,
    memo,
    used,
    created_at,
  };
}

/** クーポンの一覧を読み取る。形式が合わないものと、id が重複するものは捨てる */
export function normalizeCoupons(value: unknown): Coupon[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: Coupon[] = [];
  for (const raw of value.slice(0, MAX_COUPONS)) {
    const coupon = parseCoupon(raw);
    if (coupon === null || seen.has(coupon.id)) continue;
    seen.add(coupon.id);
    out.push(coupon);
  }
  return out;
}

/** 既存と重ならない識別子を作る */
export function newCouponId(coupons: readonly Coupon[]): string {
  const used = new Set(coupons.map((c) => c.id));
  for (let n = coupons.length + 1; ; n += 1) {
    const id = `c${n}`;
    if (!used.has(id)) return id;
  }
}

/** 期限を過ぎているか（期限の当日はまだ使える） */
export function isExpired(coupon: Coupon, today: string): boolean {
  return coupon.expires !== null && coupon.expires < today;
}

/** 期限までの残り日数 [日]（当日は 0）。期限なしは null */
export function daysLeft(coupon: Coupon, today: string): number | null {
  return coupon.expires === null ? null : daysBetween(today, coupon.expires);
}

/** 期限の近い順（期限なしは最後）。同じ期限なら登録の古い順 */
function byExpiry(a: Coupon, b: Coupon): number {
  if (a.expires !== b.expires) {
    if (a.expires === null) return 1;
    if (b.expires === null) return -1;
    return a.expires < b.expires ? -1 : 1;
  }
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
}

/** まだ使えるクーポン（未使用で期限内）。期限の近い順 */
export function activeCoupons(coupons: readonly Coupon[], today: string): Coupon[] {
  return coupons.filter((c) => !c.used && !isExpired(c, today)).sort(byExpiry);
}

/** 使用済み、または期限切れのクーポン。期限の新しい順 */
export function archivedCoupons(coupons: readonly Coupon[], today: string): Coupon[] {
  return coupons.filter((c) => c.used || isExpired(c, today)).sort((a, b) => byExpiry(b, a));
}

/**
 * その店で使えるクーポン。
 * 店舗を限定しないクーポンは、どの店（未登録の店を含む）でも対象にする
 */
export function couponsForStore(coupons: readonly Coupon[], store_id: string | null, today: string): Coupon[] {
  return activeCoupons(coupons, today).filter(
    (c) => c.store_ids.length === 0 || (store_id !== null && c.store_ids.includes(store_id)),
  );
}

/** 期限が近い（今日から EXPIRING_SOON_DAYS 日以内の）クーポン */
export function expiringSoon(coupons: readonly Coupon[], today: string): Coupon[] {
  return activeCoupons(coupons, today).filter((c) => {
    const days = daysLeft(c, today);
    return days !== null && days <= EXPIRING_SOON_DAYS;
  });
}

/** 画面に出すサービス。自分で追加したサービスは、開くページの URL（url）だけを持てる */
export interface ActiveService extends Service {
  /** 自分で追加したサービスの、開くページの URL */
  url?: string;
  /** 自分で追加したサービスか */
  custom: boolean;
}

/** 利用者が「使っている」と選んだサービス（公式の一覧から選んだもの＋自分で追加したもの） */
export function enabledServices(catalog: readonly Service[], settings: Settings): ActiveService[] {
  const enabled = new Set(settings.enabled_service_ids);
  const custom: ActiveService[] = settings.custom_services.map((c) => {
    const service: ActiveService = { id: c.id, name: c.name, custom: true };
    if (c.store_ids.length > 0) service.store_ids = [...c.store_ids];
    if (c.url !== null) service.url = c.url;
    return service;
  });
  return [...catalog.filter((s) => enabled.has(s.id)).map((s) => ({ ...s, custom: false })), ...custom];
}

/** その店に関係するサービス（対象店舗を限定していないサービスは、どの店でも対象） */
export function servicesForStore<T extends Service>(services: readonly T[], store_id: string | null): T[] {
  return services.filter((s) => s.store_ids === undefined || (store_id !== null && s.store_ids.includes(store_id)));
}

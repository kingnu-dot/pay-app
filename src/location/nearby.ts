// 近くの店の取得（OpenStreetMap の Overpass API）と、端末内の保存の管理
// 位置の座標を外へ送るのは、ここでの Overpass への問い合わせだけ。送る座標は区画の中心に丸める

/** 近くの店1件（Overpass の応答から必要な項目だけを取り出したもの） */
export interface NearbyPlace {
  /** OSM の要素の識別子（例：node/123） */
  id: string;
  /** 表示名（日本語名を優先。支店名があれば付ける） */
  name: string;
  /** 照合に使う名前（名前・日本語名・ブランド名） */
  match_names: string[];
  lat: number;
  lon: number;
  /** shop や amenity の種類 */
  category: string;
}

/** 区画（座標を小数第 3 位に丸めたもの。緯度方向で約 110m 四方） */
export interface Cell {
  key: string;
  lat: number;
  lon: number;
}

export type NearbyFetchResult =
  | { ok: true; places: NearbyPlace[] }
  /** rate_limited：利用制限（429） / busy：混雑・時間切れ（5xx） / timeout：応答が来ない / network：通信の失敗 / bad_response：応答が読めない */
  | { ok: false; reason: "rate_limited" | "busy" | "timeout" | "network" | "bad_response"; status?: number };

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** 問い合わせ先（Overpass API の主たる公開インスタンス） */
export const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
/** 検索する半径 [m] */
export const QUERY_RADIUS_M = 300;
/** 座標を丸める桁数（小数第 3 位 ≒ 緯度方向で 111m） */
export const CELL_DECIMALS = 3;
/** 応答を待つ時間の上限 [ms]（混雑時は 30 秒以上かかることがある） */
export const FETCH_TIMEOUT_MS = 45_000;
/** 1 日の問い合わせ回数の上限（利用条件に合わせ、少数に抑える） */
export const MAX_QUERIES_PER_DAY = 20;
/** 保存した区画の結果を使う期間 [日] */
export const CACHE_MAX_AGE_DAYS = 30;
/** 保存する区画の数の上限 */
export const CACHE_MAX_CELLS = 50;
/** 利用制限（429）を受けたあと、次の問い合わせまで待つ時間 [ms] */
export const PAUSE_AFTER_LIMIT_MS = 30_000;
/** 1 回の応答から取り出す店の数の上限 */
const MAX_PLACES = 500;
const MS_PER_DAY = 86_400_000;

/** 飲食などの amenity のうち、支払いをする場所として扱う種類 */
const AMENITY_TYPES = ["restaurant", "fast_food", "cafe", "fuel", "pharmacy", "food_court", "ice_cream", "bar", "pub"];

/** 座標を区画に丸める */
export function cellOf(lat: number, lon: number): Cell {
  const round = (v: number) => Number(v.toFixed(CELL_DECIMALS));
  const c_lat = round(lat);
  const c_lon = round(lon);
  return { key: `${c_lat.toFixed(CELL_DECIMALS)},${c_lon.toFixed(CELL_DECIMALS)}`, lat: c_lat, lon: c_lon };
}

/** 区画の中心から半径 300m の、名前のある店を取得する問い合わせ文 */
export function buildQuery(cell: Cell): string {
  const around = `around:${QUERY_RADIUS_M},${cell.lat.toFixed(CELL_DECIMALS)},${cell.lon.toFixed(CELL_DECIMALS)}`;
  return (
    `[out:json][timeout:25];(` +
    `nwr(${around})[shop][name];` +
    `nwr(${around})[amenity~"^(${AMENITY_TYPES.join("|")})$"][name];` +
    `);out tags center;`
  );
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const isCoord = (v: unknown, limit: number): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= limit;

/** 含まれているかの比較用に、空白・ハイフン類をそろえる */
const squash = (s: string): string =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[-‐‑‒–—―−・･\s]/g, "");

/**
 * 表示名「店名＋支店名」（例：マクドナルド 船橋駅前店）を作る。
 * - 名前に店名（ブランド）が入っていなければ、先頭にブランドを付ける（名前に支店名だけが入っている場合）
 * - 支店名（branch）があり、まだ入っていなければ、後ろに付ける
 * - 支店名が無ければ、店名だけ
 */
export function placeLabel(name: string, brand: string | null, branch: string | null): string {
  let label = name;
  if (brand !== null && !squash(label).includes(squash(brand))) label = `${brand} ${label}`;
  if (branch !== null && !squash(label).includes(squash(branch))) label = `${label} ${branch}`;
  return label;
}

/** Overpass の応答（JSON）から店の一覧を取り出す。形式が合わない要素は捨てる */
export function parseOverpass(data: unknown): NearbyPlace[] | null {
  if (!isRecord(data) || !Array.isArray(data.elements)) return null;
  const places: NearbyPlace[] = [];
  for (const e of data.elements.slice(0, MAX_PLACES * 2)) {
    if (!isRecord(e) || !isRecord(e.tags)) continue;
    const tags = e.tags;
    const center = isRecord(e.center) ? e.center : e;
    const lat = center.lat;
    const lon = center.lon;
    if (!isCoord(lat, 90) || !isCoord(lon, 180)) continue;
    const name = text(tags["name:ja"]) ?? text(tags.name);
    if (name === null) continue;
    const match_names = [tags.name, tags["name:ja"], tags.brand, tags["brand:ja"], tags["brand:en"]]
      .map(text)
      .filter((n): n is string => n !== null);
    places.push({
      id: `${String(e.type)}/${String(e.id)}`,
      name: placeLabel(name, text(tags["brand:ja"]) ?? text(tags.brand), text(tags["branch:ja"]) ?? text(tags.branch)),
      match_names: [...new Set(match_names)],
      lat,
      lon,
      category: text(tags.shop) ?? text(tags.amenity) ?? "",
    });
    if (places.length >= MAX_PLACES) break;
  }
  return places;
}

/**
 * 区画の店を Overpass に問い合わせる。
 * 送り元として、このアプリのアドレス（オリジン）だけを送る（利用条件のアプリ識別のため）
 */
export async function fetchNearby(cell: Cell, fetch_fn: FetchFn, timeout_ms = FETCH_TIMEOUT_MS): Promise<NearbyFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout_ms);
  try {
    const response = await fetch_fn(OVERPASS_URL, {
      method: "POST",
      body: new URLSearchParams({ data: buildQuery(cell) }),
      referrerPolicy: "origin",
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    if (response.status === 429) return { ok: false, reason: "rate_limited", status: 429 };
    if (response.status >= 500) return { ok: false, reason: "busy", status: response.status };
    if (!response.ok) return { ok: false, reason: "bad_response", status: response.status };
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return { ok: false, reason: "bad_response", status: response.status };
    }
    const places = parseOverpass(data);
    return places === null ? { ok: false, reason: "bad_response", status: response.status } : { ok: true, places };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return { ok: false, reason: "timeout" };
    return { ok: false, reason: "network" };
  } finally {
    clearTimeout(timer);
  }
}

/** 2 点間の距離 [m]（球面の大円距離） */
export function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_008.8;
  const rad = Math.PI / 180;
  const d_lat = (lat2 - lat1) * rad;
  const d_lon = (lon2 - lon1) * rad;
  const a = Math.sin(d_lat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(d_lon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---- 端末内の保存（区画ごとの結果と、問い合わせ回数） ----

export interface NearbyCache {
  /** 区画ごとの結果 */
  cells: Record<string, { fetched_at: string; places: NearbyPlace[] }>;
  /** その日の問い合わせ回数（日付は Asia/Tokyo の暦日） */
  queries: { date: string; count: number };
  /** 利用制限を受けたとき、次に問い合わせてよい時刻（ISO 8601） */
  pause_until: string | null;
}

export const emptyNearbyCache = (): NearbyCache => ({ cells: {}, queries: { date: "", count: 0 }, pause_until: null });

/** 保存データを読み取る。形式が合わなければ空にする */
export function normalizeNearbyCache(value: unknown): NearbyCache {
  const cache = emptyNearbyCache();
  if (!isRecord(value)) return cache;
  if (isRecord(value.cells)) {
    for (const [key, cell] of Object.entries(value.cells)) {
      if (!isRecord(cell) || typeof cell.fetched_at !== "string" || Number.isNaN(Date.parse(cell.fetched_at))) continue;
      const places = Array.isArray(cell.places) ? (cell.places as NearbyPlace[]) : [];
      cache.cells[key] = { fetched_at: cell.fetched_at, places };
    }
  }
  if (isRecord(value.queries) && typeof value.queries.date === "string" && typeof value.queries.count === "number") {
    cache.queries = { date: value.queries.date, count: value.queries.count };
  }
  if (typeof value.pause_until === "string" && !Number.isNaN(Date.parse(value.pause_until))) cache.pause_until = value.pause_until;
  return cache;
}

/** 古い区画（30 日より前）を消し、新しい順に 50 区画までに減らす */
export function pruneCells(cache: NearbyCache, now: Date): NearbyCache {
  const oldest = now.getTime() - CACHE_MAX_AGE_DAYS * MS_PER_DAY;
  const kept = Object.entries(cache.cells)
    .filter(([, c]) => Date.parse(c.fetched_at) >= oldest)
    .sort(([, a], [, b]) => Date.parse(b.fetched_at) - Date.parse(a.fetched_at))
    .slice(0, CACHE_MAX_CELLS);
  return { ...cache, cells: Object.fromEntries(kept) };
}

/** 今、問い合わせてよいか。だめなら理由を返す */
export function queryBlock(cache: NearbyCache, today: string, now: Date): "daily_limit" | "paused" | null {
  if (cache.pause_until !== null && Date.parse(cache.pause_until) > now.getTime()) return "paused";
  if (cache.queries.date === today && cache.queries.count >= MAX_QUERIES_PER_DAY) return "daily_limit";
  return null;
}

/** 問い合わせを 1 回数える（日付が変わっていれば数え直す） */
export function countQuery(cache: NearbyCache, today: string): NearbyCache {
  const count = cache.queries.date === today ? cache.queries.count + 1 : 1;
  return { ...cache, queries: { date: today, count } };
}

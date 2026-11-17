// 近くの店（OSM の名前）と、登録済みの店舗（名前・別名）の照合

import type { Store } from "../rules/types";
import { distanceMeters, type NearbyPlace } from "./nearby";

/** 照合結果1件 */
export interface MatchedPlace {
  place: NearbyPlace;
  /** 一致した登録店舗。一致しなければ null */
  store_id: string | null;
  /** 現在地からの距離 [m] */
  distance_m: number;
}

/** 照合に使う最短の文字数（短すぎる別名で誤って一致させない） */
const MIN_KEY_LENGTH = 2;

/**
 * 比較用に表記をそろえる：全角英数→半角、大文字→小文字、カタカナ→ひらがな、
 * ハイフン類と中黒を除く（「セブン-イレブン」「セブン‐イレブン」「セブンイレブン」を同じにする）。
 * 空白は残す（「ガスト 東京店」と「ガストロノミー」を区別するため）
 */
export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[-‐‑‒–—―−・･'’.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * OSM の名前が、登録店舗の名前（または別名）と一致するか。
 * - 名前・ブランド名がそのまま同じ
 * - 名前が「チェーン名＋空白＋支店名」の形（例：ガスト 東京駅前店）
 * 「ガストロノミー」のように、チェーン名で始まるだけの別の店は一致させない
 */
function matchesKey(candidate: string, key: string): boolean {
  return candidate === key || candidate.startsWith(`${key} `);
}

/** 近くの店を登録店舗と照合し、現在地から近い順に並べる（通販の店舗は照合しない） */
export function matchPlaces(
  places: readonly NearbyPlace[],
  stores: readonly Store[],
  position: { lat: number; lon: number },
): MatchedPlace[] {
  const keys: Array<{ key: string; store_id: string }> = [];
  for (const store of stores) {
    if (store.channel === "online") continue;
    for (const name of [store.name, ...store.aliases]) {
      const key = normalizeForMatch(name);
      if (key.length >= MIN_KEY_LENGTH) keys.push({ key, store_id: store.id });
    }
  }
  // 長い名前から順に試し、最も具体的な名前で一致させる（例：「ステーキガスト」を「ガスト」より先に）
  keys.sort((a, b) => b.key.length - a.key.length);

  return places
    .map((place) => {
      const candidates = place.match_names.map(normalizeForMatch);
      const hit = keys.find(({ key }) => candidates.some((c) => matchesKey(c, key)));
      return {
        place,
        store_id: hit?.store_id ?? null,
        distance_m: distanceMeters(position.lat, position.lon, place.lat, place.lon),
      };
    })
    .sort((a, b) => a.distance_m - b.distance_m);
}

/** 距離の表示（例：120m、1.2km） */
export function formatDistance(distance_m: number): string {
  // 10m 単位に丸める（位置の誤差より細かい数字は出さない）
  if (distance_m < 995) return `${Math.max(10, Math.round(distance_m / 10) * 10)}m`;
  return `${(distance_m / 1000).toFixed(1)}km`;
}

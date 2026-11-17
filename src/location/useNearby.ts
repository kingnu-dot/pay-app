// 現在地の取得と、近くの店の問い合わせ（画面から使うフック）
// 位置は「店名で検索したとき」と「現在地から探す」を押したときだけ取得する。常時追跡はしない

import { useCallback, useRef, useState } from "preact/hooks";
import { toJstDate } from "../engine/dates";
import { loadNearbyCache, saveNearbyCache } from "../storage/db";
import {
  MAX_QUERIES_PER_DAY,
  PAUSE_AFTER_LIMIT_MS,
  cellOf,
  countQuery,
  fetchNearby,
  pruneCells,
  queryBlock,
  type NearbyPlace,
} from "./nearby";

export interface NearbyState {
  /** idle：まだ / locating：現在地を取得中 / loading：近くの店を問い合わせ中 / ready：取得済み / error：失敗 */
  status: "idle" | "locating" | "loading" | "ready" | "error";
  /** 現在地（端末の中だけで使い、保存しない） */
  position: { lat: number; lon: number } | null;
  places: NearbyPlace[];
  message: string | null;
}

/** 取得した現在地を使い回す時間 [ms] */
const POSITION_REUSE_MS = 120_000;
/** 失敗のあと、店名の入力から自動で再試行するまで待つ時間 [ms] */
const RETRY_AFTER_FAILURE_MS = 60_000;

function currentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("unsupported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 });
  });
}

function positionMessage(e: unknown): string {
  if (typeof GeolocationPositionError !== "undefined" && e instanceof GeolocationPositionError) {
    if (e.code === e.PERMISSION_DENIED) return "位置情報の利用が許可されていません。ブラウザの設定で許可すると、近くの店を表示できます。";
    if (e.code === e.TIMEOUT) return "現在地を取得できませんでした（時間切れ）。";
  }
  return "現在地を取得できませんでした。";
}

const FAILURE_MESSAGES = {
  rate_limited: "近くの店の検索が混み合っています（利用制限）。しばらくしてから試してください。",
  busy: "近くの店の検索サーバーが混雑しています。しばらくしてから試してください。",
  timeout: "近くの店の検索に時間がかかりすぎたため、中止しました。",
  network: "近くの店を検索できませんでした（オフラインの可能性）。",
  bad_response: "近くの店の検索結果を読み取れませんでした。",
} as const;

export function useNearby() {
  const [state, setState] = useState<NearbyState>({ status: "idle", position: null, places: [], message: null });
  const busy = useRef(false);
  const last = useRef<{ at: number; key: string } | null>(null);
  /** 最後に失敗した時刻（店名の入力のたびに再試行しないため） */
  const failed_at = useRef<number | null>(null);

  /**
   * 現在地を取得し、その区画の店を用意する（区画ごとに問い合わせは 1 回だけ）。
   * manual：「現在地から探す」を押したとき。失敗の直後でも再試行する（店名の入力からは 60 秒あける）
   */
  const locate = useCallback(async (manual = false) => {
    if (busy.current) return;
    // 少し前に取得した区画の結果があれば、そのまま使う
    if (last.current !== null && Date.now() - last.current.at < POSITION_REUSE_MS) return;
    if (!manual && failed_at.current !== null && Date.now() - failed_at.current < RETRY_AFTER_FAILURE_MS) return;
    busy.current = true;
    failed_at.current = null;
    try {
      setState((s) => ({ ...s, status: "locating", message: null }));
      let position: GeolocationPosition;
      try {
        position = await currentPosition();
      } catch (e) {
        setState((s) => ({ ...s, status: "error", message: positionMessage(e) }));
        return;
      }
      const here = { lat: position.coords.latitude, lon: position.coords.longitude };
      const cell = cellOf(here.lat, here.lon);
      const now = new Date();
      let cache = pruneCells(await loadNearbyCache(), now);

      const saved = cache.cells[cell.key];
      if (saved) {
        await saveNearbyCache(cache);
        last.current = { at: Date.now(), key: cell.key };
        setState({ status: "ready", position: here, places: saved.places, message: null });
        return;
      }

      const today = toJstDate(now);
      const block = queryBlock(cache, today, now);
      if (block !== null) {
        setState({
          status: "error",
          position: here,
          places: [],
          message:
            block === "daily_limit"
              ? `今日の近くの店の検索回数の上限（${MAX_QUERIES_PER_DAY} 回）に達しました。`
              : "近くの店の検索は、少し時間をおいてから試してください。",
        });
        return;
      }

      setState({ status: "loading", position: here, places: [], message: null });
      cache = countQuery(cache, today);
      await saveNearbyCache(cache);
      const result = await fetchNearby(cell, (url, init) => fetch(url, init));
      if (!result.ok) {
        if (result.reason === "rate_limited") {
          await saveNearbyCache({ ...cache, pause_until: new Date(Date.now() + PAUSE_AFTER_LIMIT_MS).toISOString() });
        }
        setState({ status: "error", position: here, places: [], message: FAILURE_MESSAGES[result.reason] });
        return;
      }
      cache = { ...cache, cells: { ...cache.cells, [cell.key]: { fetched_at: new Date().toISOString(), places: result.places } } };
      await saveNearbyCache(pruneCells(cache, new Date()));
      last.current = { at: Date.now(), key: cell.key };
      setState({ status: "ready", position: here, places: result.places, message: null });
    } finally {
      busy.current = false;
      if (last.current === null || Date.now() - last.current.at >= POSITION_REUSE_MS) failed_at.current = Date.now();
    }
  }, []);

  return { state, locate };
}

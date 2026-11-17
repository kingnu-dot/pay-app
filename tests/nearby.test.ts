import { describe, expect, it } from "vitest";
import { formatDistance, matchPlaces, normalizeForMatch } from "../src/location/match";
import {
  MAX_QUERIES_PER_DAY,
  OVERPASS_URL,
  buildQuery,
  cellOf,
  countQuery,
  distanceMeters,
  emptyNearbyCache,
  fetchNearby,
  normalizeNearbyCache,
  parseOverpass,
  pruneCells,
  queryBlock,
  type FetchFn,
  type NearbyPlace,
} from "../src/location/nearby";
import type { Store } from "../src/rules/types";

// 架空の座標と店（実在の店の位置ではない）
const POS = { lat: 35.12345, lon: 139.98765 };

describe("区画と問い合わせ文", () => {
  it("座標を小数第 3 位に丸める", () => {
    expect(cellOf(35.12345, 139.98765)).toEqual({ key: "35.123,139.988", lat: 35.123, lon: 139.988 });
    // 負の小さな値は「-0.000」ではなく「0.000」にそろう（同じ区画が 2 つの名前を持たない）
    expect(cellOf(35.1236, -0.0004).key).toBe("35.124,0.000");
  });

  it("近い 2 点は同じ区画になり、離れると別の区画になる", () => {
    expect(cellOf(35.12301, 139.98801).key).toBe(cellOf(35.12349, 139.98849).key);
    expect(cellOf(35.1234, 139.988).key).not.toBe(cellOf(35.1236, 139.988).key);
  });

  it("問い合わせ文は、丸めた座標・半径 300m・名前のある店だけを指定する", () => {
    const q = buildQuery(cellOf(POS.lat, POS.lon));
    expect(q).toContain("around:300,35.123,139.988");
    expect(q).toContain("[shop][name]");
    expect(q).toContain('[amenity~"^(restaurant|fast_food|cafe|');
    expect(q).toContain("out tags center;");
    // 丸める前の細かい座標は送らない
    expect(q).not.toContain("35.12345");
  });
});

describe("Overpass の応答の読み取り", () => {
  const data = {
    elements: [
      { type: "node", id: 1, lat: 35.1231, lon: 139.9881, tags: { name: "店舗S", brand: "店舗S", shop: "convenience", branch: "駅前店" } },
      { type: "way", id: 2, center: { lat: 35.1232, lon: 139.9882 }, tags: { name: "Shop T", "name:ja": "店舗T", amenity: "cafe" } },
      { type: "node", id: 3, lat: 35.1233, lon: 139.9883, tags: { shop: "bakery" } }, // 名前なし
      { type: "node", id: 4, tags: { name: "座標なし", shop: "bakery" } },
      { type: "node", id: 5, lat: 999, lon: 0, tags: { name: "範囲外", shop: "bakery" } },
      "壊れた要素",
    ],
  };

  it("名前と座標のある店だけを取り出し、日本語名と支店名を表示名にする", () => {
    expect(parseOverpass(data)).toEqual([
      { id: "node/1", name: "店舗S 駅前店", match_names: ["店舗S"], lat: 35.1231, lon: 139.9881, category: "convenience" },
      { id: "way/2", name: "店舗T", match_names: ["Shop T", "店舗T"], lat: 35.1232, lon: 139.9882, category: "cafe" },
    ]);
  });

  it("形式が違う応答は読めないとして null を返す", () => {
    expect(parseOverpass(null)).toBeNull();
    expect(parseOverpass({ remark: "error" })).toBeNull();
  });
});

describe("Overpass への問い合わせ", () => {
  const respond = (body: string, status = 200): FetchFn => async () => new Response(body, { status });

  it("POST で送り、送り元はアプリのアドレス（オリジン）だけにする", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch_fn: FetchFn = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ elements: [] }));
    };
    expect(await fetchNearby(cellOf(POS.lat, POS.lon), fetch_fn)).toEqual({ ok: true, places: [] });
    expect(calls[0]?.url).toBe(OVERPASS_URL);
    expect(calls[0]?.init).toMatchObject({ method: "POST", referrerPolicy: "origin", credentials: "omit" });
    expect(String(calls[0]?.init.body)).toContain("around%3A300%2C35.123%2C139.988");
  });

  it("429 は利用制限、5xx は混雑、読めない応答は bad_response", async () => {
    const cell = cellOf(POS.lat, POS.lon);
    expect(await fetchNearby(cell, respond("", 429))).toEqual({ ok: false, reason: "rate_limited", status: 429 });
    expect(await fetchNearby(cell, respond("# 502", 502))).toEqual({ ok: false, reason: "busy", status: 502 });
    expect(await fetchNearby(cell, respond("not json"))).toEqual({ ok: false, reason: "bad_response", status: 200 });
  });

  it("応答が時間内に来なければ timeout、通信の失敗は network", async () => {
    const cell = cellOf(POS.lat, POS.lon);
    const hang: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    expect(await fetchNearby(cell, hang, 20)).toEqual({ ok: false, reason: "timeout" });
    expect(await fetchNearby(cell, () => Promise.reject(new TypeError("Failed to fetch")))).toEqual({ ok: false, reason: "network" });
  });
});

describe("距離", () => {
  it("緯度 0.001 度は約 111m、同じ点は 0m", () => {
    expect(Math.round(distanceMeters(35, 139, 35.001, 139))).toBe(111);
    expect(distanceMeters(35, 139, 35, 139)).toBe(0);
  });

  it("表示は 10m 単位、1km 以上は km", () => {
    expect(formatDistance(3)).toBe("10m");
    expect(formatDistance(124)).toBe("120m");
    expect(formatDistance(994)).toBe("990m");
    expect(formatDistance(995)).toBe("1.0km");
    expect(formatDistance(1260)).toBe("1.3km");
  });
});

describe("登録店舗との照合", () => {
  const stores: Store[] = [
    { id: "store_s", name: "セブン-イレブン", aliases: ["セブンイレブン", "7-Eleven"] },
    { id: "store_g", name: "ガスト", aliases: ["ステーキガスト"] },
    { id: "store_w", name: "通販W", aliases: [], channel: "online" },
    { id: "store_x", name: "X", aliases: [] }, // 1 文字の名前は照合に使わない
  ];
  const place = (id: string, names: string[], d_lat: number): NearbyPlace => ({
    id,
    name: names[0] ?? id,
    match_names: names,
    lat: POS.lat + d_lat,
    lon: POS.lon,
    category: "convenience",
  });
  const result = (places: NearbyPlace[]) => matchPlaces(places, stores, POS).map((m) => [m.place.id, m.store_id]);

  it("ハイフンの違い・全角半角・英字の大文字小文字を区別せずに一致させる", () => {
    expect(normalizeForMatch("セブン‐イレブン")).toBe(normalizeForMatch("セブン-イレブン"));
    expect(
      result([
        place("a", ["セブン‐イレブン"], 0.001),
        place("b", ["7-ELEVEN"], 0.002),
        place("c", ["ｾﾌﾞﾝｲﾚﾌﾞﾝ"], 0.003),
      ]),
    ).toEqual([
      ["a", "store_s"],
      ["b", "store_s"],
      ["c", "store_s"],
    ]);
  });

  it("「チェーン名＋空白＋支店名」は一致し、チェーン名で始まるだけの別の店は一致しない", () => {
    expect(
      result([
        place("a", ["ガスト 駅前店"], 0.001),
        place("b", ["ガストロノミー"], 0.002),
        place("c", ["ステーキガスト"], 0.003),
      ]),
    ).toEqual([
      ["a", "store_g"],
      ["b", null],
      ["c", "store_g"],
    ]);
  });

  it("名前が違っても、ブランド名が一致すれば一致させる", () => {
    expect(result([place("a", ["コンビニ 駅前", "7-Eleven"], 0.001)])).toEqual([["a", "store_s"]]);
  });

  it("通販の店舗と、1 文字の名前では照合しない", () => {
    expect(result([place("a", ["通販W"], 0.001), place("b", ["X"], 0.002)])).toEqual([
      ["a", null],
      ["b", null],
    ]);
  });

  it("現在地から近い順に並べ、距離を付ける", () => {
    const matched = matchPlaces([place("far", ["ガスト"], 0.002), place("near", ["ガスト"], 0.001)], stores, POS);
    expect(matched.map((m) => [m.place.id, Math.round(m.distance_m)])).toEqual([
      ["near", 111],
      ["far", 222],
    ]);
  });
});

describe("端末内の保存と問い合わせ回数", () => {
  const NOW = new Date("2026-11-18T03:00:00.000Z");
  const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

  it("30 日より古い区画を消し、新しい順に 50 区画までに減らす", () => {
    const cache = emptyNearbyCache();
    cache.cells["old"] = { fetched_at: daysAgo(31), places: [] };
    cache.cells["edge"] = { fetched_at: daysAgo(30), places: [] };
    for (let i = 0; i < 55; i += 1) cache.cells[`c${i}`] = { fetched_at: daysAgo(i / 10), places: [] };
    const pruned = pruneCells(cache, NOW);
    expect(Object.keys(pruned.cells)).toHaveLength(50);
    expect(pruned.cells["old"]).toBeUndefined();
    expect(pruned.cells["c0"]).toBeDefined();
    expect(pruned.cells["edge"]).toBeUndefined(); // 50 区画に入らない
  });

  it("1 日の上限に達したら問い合わせない。日付が変われば数え直す", () => {
    let cache = emptyNearbyCache();
    for (let i = 0; i < MAX_QUERIES_PER_DAY; i += 1) {
      expect(queryBlock(cache, "2026-11-18", NOW)).toBeNull();
      cache = countQuery(cache, "2026-11-18");
    }
    expect(queryBlock(cache, "2026-11-18", NOW)).toBe("daily_limit");
    expect(queryBlock(cache, "2026-11-19", NOW)).toBeNull();
    expect(countQuery(cache, "2026-11-19").queries).toEqual({ date: "2026-11-19", count: 1 });
  });

  it("利用制限を受けたあとは、指定の時刻まで問い合わせない", () => {
    const cache = { ...emptyNearbyCache(), pause_until: new Date(NOW.getTime() + 30_000).toISOString() };
    expect(queryBlock(cache, "2026-11-18", NOW)).toBe("paused");
    expect(queryBlock(cache, "2026-11-18", new Date(NOW.getTime() + 30_001))).toBeNull();
  });

  it("壊れた保存データは空として読み、正しい部分は残す", () => {
    expect(normalizeNearbyCache(null)).toEqual(emptyNearbyCache());
    const read = normalizeNearbyCache({
      cells: { a: { fetched_at: daysAgo(1), places: [] }, b: { fetched_at: "いつか" }, c: "x" },
      queries: { date: "2026-11-18", count: 3 },
      pause_until: 5,
    });
    expect(Object.keys(read.cells)).toEqual(["a"]);
    expect(read.queries).toEqual({ date: "2026-11-18", count: 3 });
    expect(read.pause_until).toBeNull();
  });
});

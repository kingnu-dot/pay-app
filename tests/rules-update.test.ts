import { describe, expect, it } from "vitest";
import { diffRules } from "../src/rules/diff";
import type { FetchOutcome } from "../src/rules/fetch";
import { restoreHeldRules, rollbackRules, syncRules, type CachedRules, type RulesCache, type RulesState } from "../src/rules/sync";
import { parseRules } from "../src/rules/validate";
import type { Rules } from "../src/rules/types";
import sample from "./fixtures/sample-rules.json";

const parsed = parseRules(sample);
if (!parsed.ok) throw new Error("サンプルルールが不正です");
const v1: Rules = parsed.rules;

/** v1 を書き換えた新しい版 */
function v2Of(change: (r: Rules) => void): Rules {
  const copy = structuredClone(v1);
  copy.updated_at = "2026-02-01";
  change(copy);
  const result = parseRules(copy);
  if (!result.ok) throw new Error(result.errors.join(" / "));
  return result.rules;
}
const v2 = v2Of((r) => {
  r.store_groups[0]!.store_ids = ["store_s"]; // 店舗U を対象店から外す
});

const NOW = new Date("2026-02-02T00:00:00.000Z");
const cached = (rules: unknown, etag: string): CachedRules => ({ rules, etag, fetched_at: "2026-01-10T00:00:00.000Z" });

function memoryCache(initial: RulesState): RulesCache & { state: RulesState } {
  const cache = {
    state: initial,
    async load() {
      return cache.state;
    },
    async save(state: RulesState) {
      cache.state = state;
    },
  };
  return cache;
}
const fetcherOf = (outcome: FetchOutcome) => async () => outcome;

describe("diffRules：変更点の一覧", () => {
  it("同じルールなら変更なし", () => {
    expect(diffRules(v1, structuredClone(v1))).toEqual([]);
  });

  it("対象店の一覧から外れた店舗を示す", () => {
    expect(diffRules(v1, v2)).toEqual([{ kind: "removed", text: "スマホタッチ加算の対象店から削除：店舗U（商業施設内）" }]);
  });

  it("還元率・有効期間・名前・評価額の変化を示す", () => {
    const changed = v2Of((r) => {
      const rule = r.cards[0]!.rewards[1]!;
      rule.points_per_unit = 3;
      rule.meta.valid_to = "2026-12-31";
      rule.label = "スマホタッチ加算（新）";
      r.points[0]!.value_milliyen = 1200;
    });
    expect(diffRules(v1, changed).map((c) => c.text)).toEqual([
      "ポイントXの評価額：1円 → 1.2円",
      "カードA：スマホタッチ加算（新）：100円ごとに4ポイントX → 100円ごとに3ポイントX",
      "カードA：スマホタッチ加算（新）：有効期間 2025-04-01〜指定なし → 2025-04-01〜2026-12-31",
      "カードA：名前「スマホタッチ加算」→「スマホタッチ加算（新）」",
    ]);
  });

  it("ルール・店舗・サービスの追加と削除を示す", () => {
    const changed = v2Of((r) => {
      const successor = structuredClone(r.cards[0]!.rewards[1]!);
      successor.id = "card_a_touch_bonus__next";
      successor.meta.valid_from = "2027-01-01";
      r.cards[0]!.rewards.push(successor);
      r.stores.push({ id: "store_x", name: "店舗X", aliases: [] });
      r.services = (r.services ?? []).filter((s) => s.id !== "search_n");
    });
    const texts = diffRules(v1, changed).map((c) => `${c.kind}:${c.text}`);
    expect(texts).toContain("added:カードA：スマホタッチ加算（100円ごとに4ポイントX、有効 2027-01-01〜指定なし）");
    expect(texts).toContain("added:店舗：店舗X");
    expect(texts).toContain("removed:サービス：優待検索N");
  });
});

describe("syncRules：更新の通知", () => {
  it("新しい版に差し替えたときは、変更点と「戻せる」を返す", async () => {
    const cache = memoryCache({ current: cached(v1, '"v1"'), previous: null });
    const result = await syncRules({ cache, fetcher: fetcherOf({ status: "updated", rules: v2, etag: '"v2"' }), now: () => NOW });
    expect(result).toMatchObject({ updated: true, on_hold: false, can_rollback: true });
    expect(result.changes).toHaveLength(1);
  });

  it("初めて取得したときは、比べる相手がないので変更点は空で、戻せない", async () => {
    const cache = memoryCache({ current: null, previous: null });
    const result = await syncRules({ cache, fetcher: fetcherOf({ status: "updated", rules: v1, etag: '"v1"' }), now: () => NOW });
    expect(result).toMatchObject({ updated: true, changes: [], can_rollback: false });
  });

  it("変更なし（304）のときは、変更点は空で、直前版があれば戻せる", async () => {
    const cache = memoryCache({ current: cached(v2, '"v2"'), previous: cached(v1, '"v1"') });
    const result = await syncRules({ cache, fetcher: fetcherOf({ status: "not_modified" }), now: () => NOW });
    expect(result).toMatchObject({ updated: false, changes: [], can_rollback: true, on_hold: false });
  });
});

describe("1つ前に戻す・保留・最新に戻す", () => {
  it("戻すと直前版が現行になり、戻した版は保留になる", async () => {
    const cache = memoryCache({ current: cached(v2, '"v2"'), previous: cached(v1, '"v1"') });
    expect(await rollbackRules(cache)).toBe(true);
    expect([cache.state.current?.etag, cache.state.previous, cache.state.held?.etag]).toEqual(['"v1"', null, '"v2"']);
  });

  it("保留中は、同じ版を取得しても再適用しない（1つ前の版で動き続ける）", async () => {
    const cache = memoryCache({ current: cached(v1, '"v1"'), previous: null, held: cached(v2, '"v2"') });
    const result = await syncRules({ cache, fetcher: fetcherOf({ status: "updated", rules: v2, etag: '"v2"' }), now: () => NOW });
    expect(result).toMatchObject({ updated: false, on_hold: true, origin: "cache" });
    expect(result.rules?.updated_at).toBe("2026-01-10");
    expect(cache.state.current?.etag).toBe('"v1"');
  });

  it("ETag が違っても内容が同じなら、同じ版として扱う", async () => {
    const cache = memoryCache({ current: cached(v1, '"v1"'), previous: null, held: cached(v2, '"v2"') });
    const result = await syncRules({ cache, fetcher: fetcherOf({ status: "updated", rules: v2, etag: '"v2-other"' }), now: () => NOW });
    expect(result.on_hold).toBe(true);
  });

  it("保留中でも、さらに新しい版が来たら通常どおり適用し、保留を解除する", async () => {
    const v3 = v2Of((r) => {
      r.updated_at = "2026-03-01";
    });
    const cache = memoryCache({ current: cached(v1, '"v1"'), previous: null, held: cached(v2, '"v2"') });
    const result = await syncRules({ cache, fetcher: fetcherOf({ status: "updated", rules: v3, etag: '"v3"' }), now: () => NOW });
    expect(result).toMatchObject({ updated: true, on_hold: false });
    expect([cache.state.current?.etag, cache.state.previous?.etag, cache.state.held]).toEqual(['"v3"', '"v1"', null]);
  });

  it("最新に戻すと、保留していた版が現行になり、戻す前の版が直前版になる", async () => {
    const cache = memoryCache({ current: cached(v1, '"v1"'), previous: null, held: cached(v2, '"v2"') });
    expect(await restoreHeldRules(cache)).toBe(true);
    expect([cache.state.current?.etag, cache.state.previous?.etag, cache.state.held]).toEqual(['"v2"', '"v1"', null]);
  });

  it("直前版が無い、または保留が無いときは何もしない", async () => {
    const cache = memoryCache({ current: cached(v1, '"v1"'), previous: null });
    expect(await rollbackRules(cache)).toBe(false);
    expect(await restoreHeldRules(cache)).toBe(false);
    expect(cache.state.current?.etag).toBe('"v1"');
  });

  it("直前版が今のアプリの検証に通らないときは戻さない", async () => {
    const cache = memoryCache({ current: cached(v2, '"v2"'), previous: cached({ schema_version: 1 }, '"old"') });
    expect(await rollbackRules(cache)).toBe(false);
  });

  it("保留の項目がない古い保存データでも動く", async () => {
    const cache = memoryCache({ current: cached(v1, '"v1"'), previous: null });
    const result = await syncRules({ cache, fetcher: fetcherOf({ status: "not_modified" }), now: () => NOW });
    expect(result).toMatchObject({ on_hold: false, can_rollback: false });
  });
});

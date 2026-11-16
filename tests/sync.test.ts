import { describe, expect, it } from "vitest";
import type { FetchOutcome } from "../src/rules/fetch";
import { syncRules, type CachedRules, type RulesCache, type RulesState } from "../src/rules/sync";
import { parseRules } from "../src/rules/validate";
import type { Rules } from "../src/rules/types";
import sample from "./fixtures/sample-rules.json";

const parsed = parseRules(sample);
if (!parsed.ok) throw new Error("サンプルルールが不正です");
const rules_v1: Rules = parsed.rules;
const rules_v2: Rules = { ...structuredClone(rules_v1), updated_at: "2026-02-01" };
const rules_v3: Rules = { ...structuredClone(rules_v1), updated_at: "2026-03-01" };

const NOW = new Date("2026-03-05T03:00:00Z");
const cached = (rules: unknown, etag: string): CachedRules => ({ rules, etag, fetched_at: "2026-02-01T00:00:00.000Z" });

/** メモリ上の偽キャッシュ */
function memoryCache(initial: RulesState): RulesCache & { state: RulesState; saves: number } {
  const cache = {
    state: initial,
    saves: 0,
    async load() {
      return cache.state;
    },
    async save(state: RulesState) {
      cache.state = state;
      cache.saves += 1;
    },
  };
  return cache;
}

/** 決まった結果を返す偽の取得関数。受け取った ETag を記録する */
function fetcherOf(outcome: FetchOutcome): { fetcher: (etag: string | null) => Promise<FetchOutcome>; etags: Array<string | null> } {
  const etags: Array<string | null> = [];
  return {
    etags,
    fetcher: async (etag) => {
      etags.push(etag);
      return outcome;
    },
  };
}

const EMPTY: RulesState = { current: null, previous: null };

describe("syncRules：取得できた場合", () => {
  it("初回：取得した版を保存して使う", async () => {
    const cache = memoryCache(EMPTY);
    const { fetcher, etags } = fetcherOf({ status: "updated", rules: rules_v1, etag: '"v1"' });
    const result = await syncRules({ cache, fetcher, now: () => NOW });
    expect(result).toMatchObject({ origin: "network", updated: true, problem: null, fetched_at: NOW.toISOString() });
    expect(result.rules?.updated_at).toBe("2026-01-10");
    expect(etags).toEqual([null]);
    expect(cache.state.current).toMatchObject({ etag: '"v1"', fetched_at: NOW.toISOString() });
    expect(cache.state.previous).toBeNull();
  });

  it("更新あり：現行版を直前版へ退避してから差し替える", async () => {
    const cache = memoryCache({ current: cached(rules_v1, '"v1"'), previous: null });
    const { fetcher, etags } = fetcherOf({ status: "updated", rules: rules_v2, etag: '"v2"' });
    const result = await syncRules({ cache, fetcher, now: () => NOW });
    expect(etags).toEqual(['"v1"']);
    expect(result.rules?.updated_at).toBe("2026-02-01");
    expect(cache.state.current?.etag).toBe('"v2"');
    expect(cache.state.previous?.etag).toBe('"v1"');
  });

  it("直前版は1つだけ持つ（2回更新すると最初の版は消える）", async () => {
    const cache = memoryCache({ current: cached(rules_v2, '"v2"'), previous: cached(rules_v1, '"v1"') });
    await syncRules({ cache, fetcher: fetcherOf({ status: "updated", rules: rules_v3, etag: '"v3"' }).fetcher, now: () => NOW });
    expect([cache.state.current?.etag, cache.state.previous?.etag]).toEqual(['"v3"', '"v2"']);
  });

  it("変更なし（304）：キャッシュをそのまま使い、保存し直さない", async () => {
    const cache = memoryCache({ current: cached(rules_v1, '"v1"'), previous: null });
    const result = await syncRules({ cache, fetcher: fetcherOf({ status: "not_modified" }).fetcher, now: () => NOW });
    expect(result).toMatchObject({ origin: "cache", updated: false, problem: null, fetched_at: "2026-02-01T00:00:00.000Z" });
    expect(cache.saves).toBe(0);
  });
});

describe("syncRules：取得できなかった場合はキャッシュで動かす", () => {
  const failures: Array<[FetchOutcome, string]> = [
    [{ status: "unauthorized" }, "unauthorized"],
    [{ status: "forbidden" }, "forbidden"],
    [{ status: "not_found" }, "not_found"],
    [{ status: "network_error" }, "network_error"],
    [{ status: "rate_limited", reset_at_s: 1767225600 }, "rate_limited"],
    [{ status: "http_error", code: 500 }, "http_error"],
    [{ status: "invalid", errors: ["/points: must be array"] }, "invalid"],
  ];

  it.each(failures)("%o → キャッシュを使い、問題の種類を返す", async (outcome, kind) => {
    const cache = memoryCache({ current: cached(rules_v1, '"v1"'), previous: null });
    const result = await syncRules({ cache, fetcher: fetcherOf(outcome).fetcher, now: () => NOW });
    expect(result.origin).toBe("cache");
    expect(result.rules?.updated_at).toBe("2026-01-10");
    expect(result.problem?.kind).toBe(kind);
    expect(cache.saves).toBe(0);
  });

  it("新しいルールが不正なときは旧版を使い続け、エラー箇所を返す", async () => {
    const cache = memoryCache({ current: cached(rules_v1, '"v1"'), previous: null });
    const result = await syncRules({
      cache,
      fetcher: fetcherOf({ status: "invalid", errors: ["/cards/0/rewards/0/meta: must have required property 'source_url'"] }).fetcher,
      now: () => NOW,
    });
    expect(result.problem).toEqual({
      kind: "invalid",
      errors: ["/cards/0/rewards/0/meta: must have required property 'source_url'"],
    });
    expect(cache.state.current?.etag).toBe('"v1"');
  });

  it("キャッシュも無いときは、ルールなしとして問題を返す", async () => {
    const result = await syncRules({
      cache: memoryCache(EMPTY),
      fetcher: fetcherOf({ status: "network_error" }).fetcher,
      now: () => NOW,
    });
    expect(result).toMatchObject({ rules: null, origin: "none", problem: { kind: "network_error" } });
  });

  it("取得先が未設定なら通信せず、キャッシュがあればそれを使う", async () => {
    const with_cache = await syncRules({
      cache: memoryCache({ current: cached(rules_v1, '"v1"'), previous: null }),
      fetcher: null,
      now: () => NOW,
    });
    expect(with_cache).toMatchObject({ origin: "cache", problem: { kind: "not_configured" } });
    const without = await syncRules({ cache: memoryCache(EMPTY), fetcher: null, now: () => NOW });
    expect(without).toMatchObject({ rules: null, origin: "none", problem: { kind: "not_configured" } });
  });
});

describe("syncRules：端末のキャッシュが壊れている場合", () => {
  const broken = cached({ schema_version: 1 }, '"old"');

  it("ETag を送らずに取り直し、取れたら差し替える（壊れた版は直前版にしない）", async () => {
    const cache = memoryCache({ current: broken, previous: cached(rules_v1, '"v1"') });
    const { fetcher, etags } = fetcherOf({ status: "updated", rules: rules_v2, etag: '"v2"' });
    const result = await syncRules({ cache, fetcher, now: () => NOW });
    expect(etags).toEqual([null]);
    expect(result).toMatchObject({ origin: "network", updated: true, problem: null });
    expect([cache.state.current?.etag, cache.state.previous?.etag]).toEqual(['"v2"', '"v1"']);
  });

  it("取り直しにも失敗したら、ルールなしとして取得側の問題を返す", async () => {
    const result = await syncRules({
      cache: memoryCache({ current: broken, previous: null }),
      fetcher: fetcherOf({ status: "network_error" }).fetcher,
      now: () => NOW,
    });
    expect(result).toMatchObject({ rules: null, origin: "none", problem: { kind: "network_error" } });
  });

  it("取得先が未設定で、キャッシュも壊れているときは未設定として返す", async () => {
    const result = await syncRules({ cache: memoryCache({ current: broken, previous: null }), fetcher: null, now: () => NOW });
    expect(result).toMatchObject({ rules: null, origin: "none", problem: { kind: "not_configured" } });
  });
});

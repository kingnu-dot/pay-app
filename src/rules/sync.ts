// 起動時のルール同期：最新版を取りに行き、取れなければ端末のキャッシュで動かす
// 保存先と通信は外から渡す（テストでは偽物に差し替える）

import { diffRules, type RuleChange } from "./diff";
import type { FetchOutcome } from "./fetch";
import { parseRules } from "./validate";
import type { Rules } from "./types";

/** 端末に保存するルール1版 */
export interface CachedRules {
  /** 取得したときの JSON（読み込むたびに検証し直す） */
  rules: unknown;
  etag: string | null;
  /** 取得した時刻（ISO 8601） */
  fetched_at: string;
}

/**
 * 現行版・直前版・保留中の版。
 * - previous：「1つ前に戻す」ための版
 * - held：利用者が戻した（使わないことにした）新しい版。同じ版を取得しても再適用しない。「最新に戻す」で使う
 */
export interface RulesState {
  current: CachedRules | null;
  previous: CachedRules | null;
  /** 古い保存データには無い項目なので省略可 */
  held?: CachedRules | null;
}

export interface RulesCache {
  load(): Promise<RulesState>;
  save(state: RulesState): Promise<void>;
}

export type SyncProblem =
  /** 取得先やトークンが未設定 */
  | { kind: "not_configured" }
  /** トークンが無効・期限切れ → 「トークンを更新してください」と表示する */
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "rate_limited"; reset_at_s: number | null }
  | { kind: "http_error"; code: number }
  | { kind: "network_error" }
  /** 新しいルールが検証に通らなかった（旧版を使い続ける） */
  | { kind: "invalid"; errors: string[] }
  /** 端末のキャッシュが、今のアプリの検証に通らなかった */
  | { kind: "cache_invalid"; errors: string[] };

export interface SyncResult {
  /** 判定に使うルール。1つも無ければ null */
  rules: Rules | null;
  /** network：今回取得した版 / cache：端末のキャッシュ / none：ルールなし */
  origin: "network" | "cache" | "none";
  /** 今回、新しい版に差し替えたか */
  updated: boolean;
  /** 差し替えたときの変更点（直前版との比較）。差し替えていなければ空 */
  changes: RuleChange[];
  /** 利用者が新しい版を保留にして、1つ前の版で動いているか */
  on_hold: boolean;
  /** 「1つ前に戻す」ができるか */
  can_rollback: boolean;
  /** 使っているルールを取得した時刻（ISO 8601） */
  fetched_at: string | null;
  problem: SyncProblem | null;
}

/** 同じ版か（ETag が同じか、内容が同じ） */
function sameVersion(a: CachedRules, etag: string | null, rules: unknown): boolean {
  if (a.etag !== null && etag !== null && a.etag === etag) return true;
  return JSON.stringify(a.rules) === JSON.stringify(rules);
}

const parsedOrNull = (cached: CachedRules | null | undefined): Rules | null => {
  if (!cached) return null;
  const parsed = parseRules(cached.rules);
  return parsed.ok ? parsed.rules : null;
};

/**
 * ルールを同期する。
 * fetcher は ETag を受け取って取得結果を返す関数。取得先が未設定なら null を渡す
 */
export async function syncRules(deps: {
  cache: RulesCache;
  fetcher: ((etag: string | null) => Promise<FetchOutcome>) | null;
  now: () => Date;
}): Promise<SyncResult> {
  const state = await deps.cache.load();
  const held = state.held ?? null;

  // キャッシュは読み込むたびに検証する（アプリの更新で Schema が変わっている場合があるため）
  let cached_rules: Rules | null = null;
  let cache_problem: SyncProblem | null = null;
  if (state.current !== null) {
    const parsed = parseRules(state.current.rules);
    if (parsed.ok) cached_rules = parsed.rules;
    else cache_problem = { kind: "cache_invalid", errors: parsed.errors };
  }
  const can_rollback = parsedOrNull(state.previous) !== null;
  const fromCache = (problem: SyncProblem | null): SyncResult => ({
    rules: cached_rules,
    origin: cached_rules === null ? "none" : "cache",
    updated: false,
    changes: [],
    on_hold: held !== null && cached_rules !== null,
    can_rollback: cached_rules !== null && can_rollback,
    fetched_at: cached_rules === null ? null : (state.current?.fetched_at ?? null),
    problem: problem ?? cache_problem,
  });

  if (deps.fetcher === null) return fromCache({ kind: "not_configured" });

  // キャッシュが使えないときは ETag を送らず、本体を取り直す
  const etag = cached_rules === null ? null : (state.current?.etag ?? null);
  const outcome = await deps.fetcher(etag);

  switch (outcome.status) {
    case "updated": {
      // 利用者が保留にした版と同じなら、適用しない（1つ前の版で動き続ける）
      if (held !== null && cached_rules !== null && sameVersion(held, outcome.etag, outcome.rules)) {
        return fromCache(null);
      }
      const fetched_at = deps.now().toISOString();
      await deps.cache.save({
        current: { rules: outcome.rules, etag: outcome.etag, fetched_at },
        // 使えるキャッシュがあればそれを直前版にする。無ければ、以前の直前版を残す
        previous: cached_rules !== null ? state.current : state.previous,
        // 新しい版が来たので、保留は解除する
        held: null,
      });
      return {
        rules: outcome.rules,
        origin: "network",
        updated: true,
        changes: cached_rules === null ? [] : diffRules(cached_rules, outcome.rules),
        on_hold: false,
        can_rollback: cached_rules !== null || parsedOrNull(state.previous) !== null,
        fetched_at,
        problem: null,
      };
    }
    case "not_modified":
      return fromCache(null);
    case "invalid":
      return fromCache({ kind: "invalid", errors: outcome.errors });
    case "rate_limited":
      return fromCache({ kind: "rate_limited", reset_at_s: outcome.reset_at_s });
    case "http_error":
      return fromCache({ kind: "http_error", code: outcome.code });
    case "unauthorized":
    case "forbidden":
    case "not_found":
    case "network_error":
      return fromCache({ kind: outcome.status });
  }
}

/**
 * 1つ前のルールに戻す。今のルールは「保留」にして、同じ版を取得しても再適用しない。
 * 戻せない（直前版が無い、または検証に通らない）ときは false
 */
export async function rollbackRules(cache: RulesCache): Promise<boolean> {
  const state = await cache.load();
  if (state.current === null || parsedOrNull(state.previous) === null) return false;
  await cache.save({ current: state.previous, previous: null, held: state.current });
  return true;
}

/** 保留にしていた新しいルールに戻す。保留が無い（または検証に通らない）ときは false */
export async function restoreHeldRules(cache: RulesCache): Promise<boolean> {
  const state = await cache.load();
  const held = state.held ?? null;
  if (held === null || parsedOrNull(held) === null) return false;
  await cache.save({ current: held, previous: state.current, held: null });
  return true;
}

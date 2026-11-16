// ルール JSON を GitHub の REST API から取得する（非公開リポジトリ。トークンは端末内にだけ保存する）
// 通信の関数は外から渡せるようにして、テストでは偽物に差し替える

import { parseRules } from "./validate";
import type { Rules } from "./types";

/** ルール JSON の置き場所（設定画面で入力する。コードには書かない） */
export interface RulesSource {
  owner: string;
  repo: string;
  /** リポジトリ内のファイルパス（例：rules/rules.json） */
  path: string;
}

export type FetchOutcome =
  | { status: "updated"; rules: Rules; etag: string | null }
  /** 前回から変更なし（ETag が一致） */
  | { status: "not_modified" }
  /** 取得できたが、検証に通らなかった */
  | { status: "invalid"; errors: string[] }
  /** トークンが無効・期限切れ */
  | { status: "unauthorized" }
  /** 利用回数の制限。reset_at_s は制限が解除される時刻 [UNIX 秒] */
  | { status: "rate_limited"; reset_at_s: number | null }
  /** 権限不足 */
  | { status: "forbidden" }
  /** ファイルが無い、またはトークンにそのリポジトリを読む権限が無い */
  | { status: "not_found" }
  | { status: "http_error"; code: number }
  /** オフラインなど、通信そのものの失敗 */
  | { status: "network_error" };

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** 取得するファイルの大きさの上限 [文字]。想定外に大きい応答を読み込まないため */
const MAX_BODY_CHARS = 2_000_000;

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
/** トークンに使える文字（空白や改行が混ざるとヘッダが壊れるため、貼り付けミスをここで弾く） */
const TOKEN_PATTERN = /^[A-Za-z0-9_]{20,255}$/;

/** 置き場所の入力を検査する。問題があれば、その説明の一覧を返す */
export function checkSource(source: RulesSource): string[] {
  const errors: string[] = [];
  if (!OWNER_PATTERN.test(source.owner)) errors.push("所有者名の形式が正しくありません");
  if (!REPO_PATTERN.test(source.repo) || source.repo === "." || source.repo === "..") {
    errors.push("リポジトリ名の形式が正しくありません");
  }
  const segments = source.path.split("/");
  if (segments.some((s) => !PATH_SEGMENT_PATTERN.test(s) || s === "." || s === "..")) {
    errors.push("ファイルパスの形式が正しくありません（例：rules/rules.json）");
  }
  return errors;
}

/** トークンの形式を検査する（中身が正しいかは、実際に取得してみないと分からない） */
export function isTokenFormatValid(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

/** 取得先の URL を作る。通信先は api.github.com に固定する */
export function buildContentsUrl(source: RulesSource): string {
  const errors = checkSource(source);
  if (errors.length > 0) throw new RangeError(errors.join(" / "));
  const path = source.path.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/contents/${path}`;
}

/**
 * ルールを取得して検証する。
 * etag を渡すと条件付きリクエストになり、変更がなければ本体を受け取らない（利用回数の制限にも数えられない）
 */
export async function fetchRules(args: {
  source: RulesSource;
  token: string;
  etag: string | null;
  fetch_fn: FetchFn;
}): Promise<FetchOutcome> {
  const { source, token, etag, fetch_fn } = args;
  if (!isTokenFormatValid(token)) return { status: "unauthorized" };
  const headers: Record<string, string> = {
    // 生のファイル内容を受け取る
    Accept: "application/vnd.github.raw+json",
    Authorization: `Bearer ${token}`,
  };
  if (etag !== null) headers["If-None-Match"] = etag;

  let response: Response;
  try {
    response = await fetch_fn(buildContentsUrl(source), {
      method: "GET",
      headers,
      // ブラウザのキャッシュに任せず、ETag を自分で管理する
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  } catch {
    return { status: "network_error" };
  }

  if (response.status === 304) return { status: "not_modified" };
  if (response.status === 401) return { status: "unauthorized" };
  if (response.status === 403 || response.status === 429) {
    if (response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      return { status: "rate_limited", reset_at_s: Number.isFinite(reset) && reset > 0 ? reset : null };
    }
    return { status: "forbidden" };
  }
  if (response.status === 404) return { status: "not_found" };
  if (response.status !== 200) return { status: "http_error", code: response.status };

  let text: string;
  try {
    text = await response.text();
  } catch {
    return { status: "network_error" };
  }
  if (text.length > MAX_BODY_CHARS) return { status: "invalid", errors: ["ルールのファイルが大きすぎます"] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { status: "invalid", errors: ["JSON として読めません"] };
  }
  const parsed = parseRules(data);
  if (!parsed.ok) return { status: "invalid", errors: parsed.errors };
  return { status: "updated", rules: parsed.rules, etag: response.headers.get("etag") };
}

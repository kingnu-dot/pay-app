import { describe, expect, it } from "vitest";
import { buildContentsUrl, checkSource, fetchRules, isTokenFormatValid, type FetchFn } from "../src/rules/fetch";
import sample from "./fixtures/sample-rules.json";

const source = { owner: "example-owner", repo: "example-rules", path: "rules/rules.json" };
// テスト用の架空のトークン（実在しない）
const token = "test_token_0123456789abcdef";

interface Captured {
  url: string;
  init: RequestInit;
}

/** 決まった応答を返す偽の通信関数。呼ばれた内容を calls に記録する */
function fakeFetch(respond: () => Response | Promise<Response>): { fetch_fn: FetchFn; calls: Captured[] } {
  const calls: Captured[] = [];
  return {
    calls,
    fetch_fn: async (url, init) => {
      calls.push({ url, init });
      return respond();
    },
  };
}

const ok = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers });

describe("buildContentsUrl / checkSource", () => {
  it("api.github.com の contents API の URL を作る", () => {
    expect(buildContentsUrl(source)).toBe(
      "https://api.github.com/repos/example-owner/example-rules/contents/rules/rules.json",
    );
  });

  it("別のホストや上位ディレクトリへ向かう入力を受け付けない", () => {
    expect(checkSource({ ...source, owner: "a/b" })).not.toEqual([]);
    expect(checkSource({ ...source, owner: "evil.example.com" })).not.toEqual([]);
    expect(checkSource({ ...source, repo: ".." })).not.toEqual([]);
    expect(checkSource({ ...source, repo: "a?b" })).not.toEqual([]);
    expect(checkSource({ ...source, path: "../secret.json" })).not.toEqual([]);
    expect(checkSource({ ...source, path: "rules//rules.json" })).not.toEqual([]);
    expect(checkSource({ ...source, path: "" })).not.toEqual([]);
    expect(() => buildContentsUrl({ ...source, path: "a/../b" })).toThrow(RangeError);
  });

  it("正しい入力はエラーなし", () => {
    expect(checkSource(source)).toEqual([]);
  });
});

describe("isTokenFormatValid", () => {
  it("空白・改行・短すぎる値を弾く", () => {
    expect(isTokenFormatValid(token)).toBe(true);
    expect(isTokenFormatValid("")).toBe(false);
    expect(isTokenFormatValid("short")).toBe(false);
    expect(isTokenFormatValid(`${token}\n`)).toBe(false);
    expect(isTokenFormatValid(`${token} x`)).toBe(false);
  });
});

describe("fetchRules：リクエスト", () => {
  it("トークンと生ファイル指定を付け、キャッシュや Cookie を使わない", async () => {
    const { fetch_fn, calls } = fakeFetch(() => ok(sample, { etag: '"v1"' }));
    await fetchRules({ source, token, etag: null, fetch_fn });
    expect(calls).toHaveLength(1);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${token}`);
    expect(headers.Accept).toBe("application/vnd.github.raw+json");
    expect(headers["If-None-Match"]).toBeUndefined();
    expect(calls[0]?.init).toMatchObject({ method: "GET", cache: "no-store", credentials: "omit" });
    // トークンを URL に載せない
    expect(calls[0]?.url).not.toContain(token);
  });

  it("ETag があれば条件付きリクエストにする", async () => {
    const { fetch_fn, calls } = fakeFetch(() => new Response(null, { status: 304 }));
    const outcome = await fetchRules({ source, token, etag: '"v1"', fetch_fn });
    expect((calls[0]?.init.headers as Record<string, string>)["If-None-Match"]).toBe('"v1"');
    expect(outcome).toEqual({ status: "not_modified" });
  });

  it("形式の正しくないトークンでは通信しない", async () => {
    const { fetch_fn, calls } = fakeFetch(() => ok(sample));
    expect(await fetchRules({ source, token: "bad token", etag: null, fetch_fn })).toEqual({ status: "unauthorized" });
    expect(calls).toHaveLength(0);
  });
});

describe("fetchRules：応答", () => {
  const run = (respond: () => Response | Promise<Response>) =>
    fetchRules({ source, token, etag: null, fetch_fn: fakeFetch(respond).fetch_fn });

  it("200：検証に通ればルールと ETag を返す", async () => {
    const outcome = await run(() => ok(sample, { etag: '"v2"' }));
    expect(outcome).toMatchObject({ status: "updated", etag: '"v2"' });
  });

  it("200 でも、JSON として読めなければ不正として扱う", async () => {
    expect(await run(() => ok("{ not json"))).toMatchObject({ status: "invalid" });
  });

  it("200 でも、Schema に通らなければ不正として扱い、エラー箇所を返す", async () => {
    const outcome = await run(() => ok({ ...sample, schema_version: 2 }));
    expect(outcome.status).toBe("invalid");
    if (outcome.status === "invalid") expect(outcome.errors.some((e) => e.includes("/schema_version"))).toBe(true);
  });

  it("401：トークンが無効", async () => {
    expect(await run(() => new Response("{}", { status: 401 }))).toEqual({ status: "unauthorized" });
  });

  it("403：残り回数が 0 なら利用制限、そうでなければ権限不足", async () => {
    const limited = new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1767225600" });
    expect(await run(() => new Response("{}", { status: 403, headers: limited }))).toEqual({
      status: "rate_limited",
      reset_at_s: 1767225600,
    });
    expect(await run(() => new Response("{}", { status: 403 }))).toEqual({ status: "forbidden" });
  });

  it("404：ファイルが無い、または読む権限が無い", async () => {
    expect(await run(() => new Response("{}", { status: 404 }))).toEqual({ status: "not_found" });
  });

  it("その他の状態コードはそのまま返す", async () => {
    expect(await run(() => new Response("", { status: 500 }))).toEqual({ status: "http_error", code: 500 });
  });

  it("通信そのものが失敗したら（オフラインなど）例外にせず結果として返す", async () => {
    expect(await run(() => Promise.reject(new TypeError("Failed to fetch")))).toEqual({ status: "network_error" });
  });
});

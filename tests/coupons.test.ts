import { describe, expect, it } from "vitest";
import { buildBackup, parseBackup } from "../src/backup/backup";
import {
  activeCoupons,
  archivedCoupons,
  couponsForStore,
  daysLeft,
  enabledServices,
  expiringSoon,
  isExpired,
  newCouponId,
  normalizeCoupons,
  parseCoupon,
  servicesForStore,
  type Coupon,
} from "../src/coupons/coupons";
import { appIntentUrl, calendarDate, calendarUrl, isSafeHttpsUrl, playStoreUrl, searchUrl } from "../src/coupons/links";
import { parseRules } from "../src/rules/validate";
import type { Rules } from "../src/rules/types";
import { defaultSettings, newCustomServiceId } from "../src/settings/settings";
import sample from "./fixtures/sample-rules.json";

const parsed = parseRules(sample);
if (!parsed.ok) throw new Error(`サンプルルールが不正です: ${parsed.errors.join(" / ")}`);
const rules: Rules = parsed.rules;
const TODAY = "2026-01-10";

const coupon = (id: string, change: Partial<Coupon> = {}): Coupon => ({
  id,
  title: `クーポン${id}`,
  expires: "2026-01-31",
  conditions: "",
  store_ids: [],
  service_id: null,
  memo: "",
  used: false,
  created_at: "2026-01-01T00:00:00.000Z",
  ...change,
});
const ids = (list: Coupon[]) => list.map((c) => c.id);

describe("クーポンの期限", () => {
  it("期限の当日はまだ使え、翌日から期限切れ", () => {
    const c = coupon("c1", { expires: "2026-01-10" });
    expect(isExpired(c, "2026-01-10")).toBe(false);
    expect(isExpired(c, "2026-01-11")).toBe(true);
    expect(daysLeft(c, "2026-01-10")).toBe(0);
    expect(daysLeft(c, "2026-01-03")).toBe(7);
  });

  it("期限のない優待は期限切れにならない", () => {
    const c = coupon("c1", { expires: null });
    expect(isExpired(c, "2099-01-01")).toBe(false);
    expect(daysLeft(c, TODAY)).toBeNull();
  });
});

describe("クーポンの一覧", () => {
  const list = [
    coupon("c1", { expires: "2026-02-10" }),
    coupon("c2", { expires: null }),
    coupon("c3", { expires: "2026-01-12" }),
    coupon("c4", { expires: "2026-01-09" }), // 期限切れ
    coupon("c5", { expires: "2026-01-20", used: true }), // 使用済み
    coupon("c6", { expires: "2026-01-12", created_at: "2025-12-01T00:00:00.000Z" }),
  ];

  it("使えるもの：未使用で期限内。期限の近い順、期限なしは最後、同じ期限は登録の古い順", () => {
    expect(ids(activeCoupons(list, TODAY))).toEqual(["c6", "c3", "c1", "c2"]);
  });

  it("使用済み・期限切れ：期限の新しい順", () => {
    expect(ids(archivedCoupons(list, TODAY))).toEqual(["c5", "c4"]);
  });

  it("期限が近いもの：7 日後までは出て、8 日後は出ない。期限なしは出ない", () => {
    const soon = [
      coupon("c1", { expires: "2026-01-10" }), // 今日
      coupon("c2", { expires: "2026-01-17" }), // 7 日後
      coupon("c3", { expires: "2026-01-18" }), // 8 日後
      coupon("c4", { expires: null }),
      coupon("c5", { expires: "2026-01-11", used: true }),
    ];
    expect(ids(expiringSoon(soon, TODAY))).toEqual(["c1", "c2"]);
  });
});

describe("その店で使えるクーポン", () => {
  const list = [
    coupon("c1", { store_ids: ["store_s"] }),
    coupon("c2", { store_ids: ["store_t", "store_v"] }),
    coupon("c3", { store_ids: [] }), // 店舗を限定しない
    coupon("c4", { store_ids: ["store_s"], expires: "2026-01-09" }), // 期限切れ
    coupon("c5", { store_ids: ["store_s"], used: true }),
  ];

  it("対象店舗に含まれるものと、店舗を限定しないものを返す", () => {
    expect(ids(couponsForStore(list, "store_s", TODAY))).toEqual(["c1", "c3"]);
    expect(ids(couponsForStore(list, "store_v", TODAY))).toEqual(["c2", "c3"]);
  });

  it("未登録の店では、店舗を限定しないものだけを返す", () => {
    expect(ids(couponsForStore(list, null, TODAY))).toEqual(["c3"]);
  });
});

describe("クーポンの読み取り", () => {
  it("正しい形のものはそのまま読み、前後の空白と重複した店舗は整える", () => {
    const raw = { ...coupon("c1"), title: " 100円引き ", store_ids: ["store_s", "store_s"] };
    expect(parseCoupon(raw)).toEqual({ ...coupon("c1"), title: "100円引き", store_ids: ["store_s"] });
  });

  it("形式が合わないものは読まない", () => {
    expect(parseCoupon(null)).toBeNull();
    expect(parseCoupon({ ...coupon("c1"), id: "x1" })).toBeNull();
    expect(parseCoupon({ ...coupon("c1"), title: "  " })).toBeNull();
    expect(parseCoupon({ ...coupon("c1"), expires: "2026-02-31" })).toBeNull();
    expect(parseCoupon({ ...coupon("c1"), expires: "" })).toBeNull();
    expect(parseCoupon({ ...coupon("c1"), store_ids: "store_s" })).toBeNull();
    expect(parseCoupon({ ...coupon("c1"), used: "no" })).toBeNull();
    expect(parseCoupon({ ...coupon("c1"), created_at: "いつか" })).toBeNull();
  });

  it("一覧では、読めないものと id が重複するものを捨てる", () => {
    expect(ids(normalizeCoupons([coupon("c1"), { id: "bad" }, coupon("c1", { title: "重複" }), coupon("c2")]))).toEqual(["c1", "c2"]);
    expect(normalizeCoupons("x")).toEqual([]);
  });

  it("新しい識別子は既存と重ならない", () => {
    expect(newCouponId([])).toBe("c1");
    expect(newCouponId([coupon("c1"), coupon("c2")])).toBe("c3");
    expect(newCouponId([coupon("c2"), coupon("c3")])).toBe("c4"); // 削除で番号が空いていても、既存と重ならない
  });
});

describe("バックアップとクーポン", () => {
  const settings = defaultSettings();
  const now = new Date("2026-01-10T03:00:00.000Z");

  it("クーポンを含めて書き出し、読み戻すと同じ内容になる", () => {
    const coupons = [coupon("c1", { store_ids: ["store_s"] }), coupon("c2", { expires: null })];
    const parsedBackup = parseBackup(JSON.stringify(buildBackup({ settings, spend: [], coupons, now })));
    expect(parsedBackup.ok).toBe(true);
    if (parsedBackup.ok) {
      expect(parsedBackup.backup.coupons).toEqual(coupons);
      expect(parsedBackup.summary.coupon_count).toBe(2);
    }
  });

  it("クーポンの項目がない古いバックアップは、クーポンなしとして読める", () => {
    const old = JSON.parse(JSON.stringify(buildBackup({ settings, spend: [], now }))) as Record<string, unknown>;
    delete old.coupons;
    expect(parseBackup(JSON.stringify(old))).toMatchObject({ ok: true, backup: { coupons: [] }, summary: { coupon_count: 0 } });
  });

  it("読めないクーポンが1件でもあれば全体を読み込まず、何件目かを示す", () => {
    const data = JSON.parse(JSON.stringify(buildBackup({ settings, spend: [], coupons: [coupon("c1"), coupon("c2")], now })));
    data.coupons[1].expires = "2026-13-01";
    expect(parseBackup(JSON.stringify(data))).toEqual({ ok: false, message: "クーポンの 2 件目が読めません。" });
  });
});

describe("利用中のサービス", () => {
  const catalog = rules.services ?? [];
  const settings = {
    ...defaultSettings(),
    enabled_service_ids: ["app_s", "club_m", "search_n", "service_none"],
    custom_services: [
      { id: "user_service_1", name: "店舗Tの会員ページ", store_ids: ["store_t"], url: "https://example.com/member" },
      { id: "user_service_2", name: "どの店でも使う優待", store_ids: [], url: null },
    ],
  };
  const enabled = enabledServices(catalog, settings);
  const names = (store_id: string | null) => servicesForStore(enabled, store_id).map((s) => s.id);

  it("選んだサービスと自分で追加したサービスだけが有効になる（一覧にない id は無視）", () => {
    expect(enabled.map((s) => [s.id, s.custom])).toEqual([
      ["app_s", false],
      ["club_m", false],
      ["search_n", false],
      ["user_service_1", true],
      ["user_service_2", true],
    ]);
    expect(enabled.find((s) => s.id === "user_service_1")?.url).toBe("https://example.com/member");
  });

  it("選んでいないサービス（店舗Tアプリ）は出ない", () => {
    expect(names("store_t")).not.toContain("app_t");
  });

  it("対象店舗のあるサービスはその店だけ、ないサービスはどの店でも出る", () => {
    expect(names("store_s")).toEqual(["app_s", "club_m", "search_n", "user_service_2"]);
    expect(names("store_t")).toEqual(["club_m", "search_n", "user_service_1", "user_service_2"]);
    expect(names(null)).toEqual(["club_m", "search_n", "user_service_2"]);
  });

  it("追加するサービスの id は既存と重ならない", () => {
    expect(newCustomServiceId([])).toBe("user_service_1");
    expect(newCustomServiceId(["user_service_1", "user_service_3"])).toBe("user_service_2");
  });
});

describe("サービスの検証", () => {
  const withService = (service: unknown): unknown => ({ ...structuredClone(sample), services: [service] });
  const errorsOf = (data: unknown): string[] => {
    const result = parseRules(data);
    expect(result.ok).toBe(false);
    return result.ok ? [] : result.errors;
  };

  it("サービスの項目がないルールも合格する（省略できる）", () => {
    const copy = structuredClone(sample) as Record<string, unknown>;
    delete copy.services;
    expect(parseRules(copy).ok).toBe(true);
  });

  it("存在しない店舗を対象にしたサービスは不合格", () => {
    expect(errorsOf(withService({ id: "x", name: "X", store_ids: ["store_none"], search_url_template: "https://example.com/?q={query}" }))
      .some((e) => e.includes("store_none"))).toBe(true);
  });

  it("アプリの情報も検索の URL もないサービスは不合格", () => {
    expect(errorsOf(withService({ id: "x", name: "X" })).some((e) => e.includes("少なくとも一方"))).toBe(true);
  });

  it("検索の URL に {query} がない、または https でないものは不合格", () => {
    expect(errorsOf(withService({ id: "x", name: "X", search_url_template: "https://example.com/search" })).length).toBeGreaterThan(0);
    expect(errorsOf(withService({ id: "x", name: "X", search_url_template: "http://example.com/?q={query}" })).length).toBeGreaterThan(0);
  });

  it("パッケージ名の形式が違うもの、https でない open_url は不合格", () => {
    expect(errorsOf(withService({ id: "x", name: "X", app: { android_package: "not a package" } })).length).toBeGreaterThan(0);
    expect(errorsOf(withService({ id: "x", name: "X", app: { android_package: "com.example.x", open_url: "javascript:alert(1)" } })).length)
      .toBeGreaterThan(0);
  });

  it("id が重複するサービスは不合格", () => {
    const copy = structuredClone(sample);
    copy.services[1]!.id = copy.services[0]!.id;
    expect(errorsOf(copy).some((e) => e.includes("重複") && e.includes("app_s"))).toBe(true);
  });
});

describe("カレンダーの予定", () => {
  it("予定は期限の 3 日前に置く", () => {
    expect(calendarDate("2026-01-31", TODAY)).toBe("2026-01-28");
  });

  it("3 日前が今日ならその日、すでに過ぎていれば今日にする", () => {
    expect(calendarDate("2026-01-13", TODAY)).toBe("2026-01-10");
    expect(calendarDate("2026-01-12", TODAY)).toBe("2026-01-10");
    expect(calendarDate("2026-01-10", TODAY)).toBe("2026-01-10");
  });

  it("月をまたぐ場合も正しく計算する", () => {
    expect(calendarDate("2026-03-02", TODAY)).toBe("2026-02-27");
  });

  it("タイトルに期限日を入れ、終日の予定として、条件・対象店舗・メモを説明に入れる", () => {
    const c = coupon("c1", { title: "100円引き", expires: "2026-01-31", conditions: "1,000円以上", memo: "アプリ提示" });
    const url = new URL(calendarUrl(c, TODAY, ["店舗S", "店舗T"]) ?? "");
    expect(`${url.origin}${url.pathname}`).toBe("https://calendar.google.com/calendar/render");
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("text")).toBe("【クーポン期限 1/31】100円引き");
    expect(url.searchParams.get("dates")).toBe("20260128/20260129");
    expect(url.searchParams.get("details")).toBe("期限：2026-01-31\n条件：1,000円以上\n対象店舗：店舗S、店舗T\nメモ：アプリ提示");
  });

  it("空の項目は説明に入れない。記号を含むタイトルも壊れない", () => {
    const c = coupon("c1", { title: "A&B 50%OFF #1", expires: "2026-01-11" });
    const url = new URL(calendarUrl(c, TODAY, []) ?? "");
    expect(url.searchParams.get("text")).toBe("【クーポン期限 1/11】A&B 50%OFF #1");
    expect(url.searchParams.get("dates")).toBe("20260110/20260111");
    expect(url.searchParams.get("details")).toBe("期限：2026-01-11");
  });

  it("期限のない優待は予定にできない", () => {
    expect(calendarUrl(coupon("c1", { expires: null }), TODAY, [])).toBeNull();
  });
});

describe("検索とアプリのリンク", () => {
  it("検索の URL は、{query} を店名に置き換える（日本語と記号はエンコードする）", () => {
    expect(searchUrl("https://club.example.com/search?q={query}", "店舗S")).toBe(
      "https://club.example.com/search?q=%E5%BA%97%E8%88%97S",
    );
    expect(searchUrl("https://search.example.com/{query}/coupons", "A&B/C")).toBe("https://search.example.com/A%26B%2FC/coupons");
  });

  it("Play ストアのページ", () => {
    expect(playStoreUrl("com.example.stores")).toBe("https://play.google.com/store/apps/details?id=com.example.stores");
  });

  it("open_url があれば、その URL をそのアプリで開く intent リンクにする", () => {
    expect(appIntentUrl({ android_package: "com.example.stores", open_url: "https://app.example.com/coupon?from=web" })).toBe(
      "intent://app.example.com/coupon?from=web#Intent;scheme=https;package=com.example.stores;" +
        "S.browser_fallback_url=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdetails%3Fid%3Dcom.example.stores;end",
    );
  });

  it("open_url がなければ、パッケージ名だけで起動を試みる intent リンクにする", () => {
    expect(appIntentUrl({ android_package: "com.example.storet" })).toBe(
      "intent://#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=com.example.storet;" +
        "S.browser_fallback_url=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdetails%3Fid%3Dcom.example.storet;end",
    );
  });

  it("利用者が入力する URL は https だけを受け付ける", () => {
    expect(isSafeHttpsUrl("https://example.com/member")).toBe(true);
    expect(isSafeHttpsUrl("http://example.com/")).toBe(false);
    expect(isSafeHttpsUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpsUrl("intent://x#Intent;end")).toBe(false);
    expect(isSafeHttpsUrl("https://example.com/a b")).toBe(false);
    expect(isSafeHttpsUrl("example.com")).toBe(false);
  });
});

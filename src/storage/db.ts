// 端末内の保存（IndexedDB）。クラウドには送らない
// ここはブラウザでだけ動く薄い層にとどめ、判断を伴う処理は置かない

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { normalizeCoupons, type Coupon } from "../coupons/coupons";
import { normalizeNearbyCache, type NearbyCache } from "../location/nearby";
import type { RulesSource } from "../rules/fetch";
import type { RulesCache, RulesState } from "../rules/sync";
import { normalizeSettings, type Settings } from "../settings/settings";

/** 利用額の記録1件 */
export interface SpendEntry {
  /** 保存時に自動で振られる番号 */
  id?: number;
  /** 利用日（YYYY-MM-DD、Asia/Tokyo の暦日） */
  date: string;
  /** 金額 [円]。補正の記録では負の値もある */
  amount_yen: number;
  /** payment：「これで払った」の記録 / adjustment：累計を上書き入力したときの差額 */
  kind: "payment" | "adjustment";
  method_id: string | null;
  /** 年間利用額に計上するカード。計上しない決済は null */
  annual_card_id: string | null;
  note?: string;
  /** 記録した時刻（ISO 8601） */
  created_at: string;
}

/** ルールの取得設定。トークンはここ（端末内）にだけ保存し、バックアップには含めない */
export interface RulesConfig {
  source: RulesSource | null;
  token: string | null;
}

interface PayDb extends DBSchema {
  /** 設定などの小さな値 */
  kv: { key: string; value: unknown };
  spend: { key: number; value: SpendEntry; indexes: { by_date: string } };
}

const DB_NAME = "pay-app";
const DB_VERSION = 1;
const KEY_RULES_CONFIG = "rules_config";
const KEY_RULES_STATE = "rules_state";
const KEY_SETTINGS = "settings";
const KEY_LAST_BACKUP_DATE = "last_backup_date";
const KEY_COUPONS = "coupons";
const KEY_NEARBY = "nearby";

let db_promise: Promise<IDBPDatabase<PayDb>> | null = null;

function getDb(): Promise<IDBPDatabase<PayDb>> {
  db_promise ??= openDB<PayDb>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore("kv");
      const spend = db.createObjectStore("spend", { keyPath: "id", autoIncrement: true });
      spend.createIndex("by_date", "date");
    },
  });
  return db_promise;
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await (await getDb()).get("kv", key)) as T | undefined;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await (await getDb()).put("kv", value, key);
}

export async function kvDelete(key: string): Promise<void> {
  await (await getDb()).delete("kv", key);
}

export async function loadRulesConfig(): Promise<RulesConfig> {
  return (await kvGet<RulesConfig>(KEY_RULES_CONFIG)) ?? { source: null, token: null };
}

export async function saveRulesConfig(config: RulesConfig): Promise<void> {
  await kvSet(KEY_RULES_CONFIG, config);
}

export async function loadSettings(): Promise<Settings> {
  return normalizeSettings(await kvGet(KEY_SETTINGS));
}

export async function saveSettings(settings: Settings): Promise<void> {
  await kvSet(KEY_SETTINGS, settings);
}

/** 利用額の記録をすべて読む（古い順） */
export async function listSpend(): Promise<SpendEntry[]> {
  return (await getDb()).getAll("spend");
}

export async function addSpend(entry: Omit<SpendEntry, "id">): Promise<void> {
  await (await getDb()).add("spend", entry);
}

export async function deleteSpend(id: number): Promise<void> {
  await (await getDb()).delete("spend", id);
}

/** 近くの店の検索結果（区画ごと）。位置に関わるので、バックアップには含めない */
export async function loadNearbyCache(): Promise<NearbyCache> {
  return normalizeNearbyCache(await kvGet(KEY_NEARBY));
}

export async function saveNearbyCache(cache: NearbyCache): Promise<void> {
  await kvSet(KEY_NEARBY, cache);
}

/** 近くの店の検索結果を消す（問い合わせ回数の記録は残す） */
export async function clearNearbyCache(): Promise<void> {
  const cache = await loadNearbyCache();
  await saveNearbyCache({ ...cache, cells: {} });
}

/** 登録したクーポン・優待 */
export async function loadCoupons(): Promise<Coupon[]> {
  return normalizeCoupons(await kvGet(KEY_COUPONS));
}

export async function saveCoupons(coupons: readonly Coupon[]): Promise<void> {
  await kvSet(KEY_COUPONS, coupons);
}

/** 前回バックアップを書き出した日（YYYY-MM-DD）。一度も無ければ null */
export async function loadLastBackupDate(): Promise<string | null> {
  return (await kvGet<string>(KEY_LAST_BACKUP_DATE)) ?? null;
}

export async function saveLastBackupDate(date: string): Promise<void> {
  await kvSet(KEY_LAST_BACKUP_DATE, date);
}

/** 個人設定・利用記録・クーポンを、まとめて置き換える（バックアップからの復元用。途中で失敗したら全体を取り消す） */
export async function replaceUserData(
  settings: Settings,
  spend: ReadonlyArray<Omit<SpendEntry, "id">>,
  coupons: readonly Coupon[],
): Promise<void> {
  const tx = (await getDb()).transaction(["kv", "spend"], "readwrite");
  const spend_store = tx.objectStore("spend");
  await spend_store.clear();
  for (const entry of spend) await spend_store.add(entry);
  await tx.objectStore("kv").put(settings, KEY_SETTINGS);
  await tx.objectStore("kv").put(coupons, KEY_COUPONS);
  await tx.done;
}

/** ルールのキャッシュ（現行版と直前版） */
export const idbRulesCache: RulesCache = {
  async load(): Promise<RulesState> {
    return (await kvGet<RulesState>(KEY_RULES_STATE)) ?? { current: null, previous: null };
  },
  async save(state: RulesState): Promise<void> {
    await kvSet(KEY_RULES_STATE, state);
  },
};

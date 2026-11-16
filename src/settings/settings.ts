// 個人上書き層：端末内に保存する個人設定と、公式ルールへの合成
// 判定には「公式ルール ＋ 個人設定」を合成したルールを使う（個人設定が優先）

import { DEFAULT_ANNUAL_THRESHOLD_YEN } from "../engine/advise";
import { checkIntegrity } from "../rules/validate";
import type { Rules, Store } from "../rules/types";

/** 店舗単位の例外：その店では、その還元ルールを適用しない */
export interface StoreException {
  store_id: string;
  rule_id: string;
}

/** 自分で追加した店舗（id は user_ で始める） */
export interface CustomStore {
  id: string;
  name: string;
  aliases: string[];
  channel: "in_store" | "online";
}

export interface Settings {
  version: 1;
  /** ポイントの評価額の上書き [1/1000 円]（ポイントの id → 値） */
  point_values_milliyen: Record<string, number>;
  /** 年間目標の優先に使う閾値 [円] */
  annual_threshold_yen: number;
  /** 年間目標の集計開始日の上書き（カードの id → 月日） */
  annual_period_start: Record<string, { month: number; day: number }>;
  /** 無効にした支払い手段 */
  disabled_method_ids: string[];
  /** お気に入りの店舗 */
  favorite_store_ids: string[];
  custom_stores: CustomStore[];
  /** 店舗の別名の追加（店舗の id → 別名） */
  extra_aliases: Record<string, string[]>;
  store_exceptions: StoreException[];
  /** その店で使えない支払い手段（店舗の id → 手段の id） */
  unusable_methods: Record<string, string[]>;
  /** 使っているサービス（公式の一覧から選んだもの） */
  enabled_service_ids: string[];
  /** 自分で追加したサービス */
  custom_services: CustomService[];
}

/** 自分で追加したサービス（id は user_service_ で始める） */
export interface CustomService {
  id: string;
  name: string;
  /** 対象の店舗。空ならすべての店舗 */
  store_ids: string[];
  /** 開くページの URL（https）。なければ null */
  url: string | null;
}

export const MAX_POINT_VALUE_MILLIYEN = 1_000_000;
export const MAX_THRESHOLD_YEN = 100_000;
const CUSTOM_STORE_ID = /^user_[a-z0-9_]{1,40}$/;
const CUSTOM_SERVICE_ID = /^user_service_[0-9]{1,6}$/;
const MAX_URL_LENGTH = 500;

/** 開いてよい URL か（https のみ。javascript: などを保存させない） */
function isHttpsUrl(text: string): boolean {
  if (text.length > MAX_URL_LENGTH || /\s/.test(text)) return false;
  try {
    return new URL(text).protocol === "https:";
  } catch {
    return false;
  }
}
const MAX_TEXT_LENGTH = 100;
const MAX_LIST_LENGTH = 1000;

export function defaultSettings(): Settings {
  return {
    version: 1,
    point_values_milliyen: {},
    annual_threshold_yen: DEFAULT_ANNUAL_THRESHOLD_YEN,
    annual_period_start: {},
    disabled_method_ids: [],
    favorite_store_ids: [],
    custom_stores: [],
    extra_aliases: {},
    store_exceptions: [],
    unusable_methods: {},
    enabled_service_ids: [],
    custom_services: [],
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && v.length <= MAX_TEXT_LENGTH;
const isIntIn = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const textList = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter(isText).map((s) => s.trim()))].slice(0, MAX_LIST_LENGTH) : [];

/** 文字列の一覧を値に持つ対応表を読み取る */
function textListRecord(v: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!isRecord(v)) return out;
  for (const [key, value] of Object.entries(v)) {
    const list = textList(value);
    if (isText(key) && list.length > 0) out[key] = list;
  }
  return out;
}

/**
 * 保存されていた値やバックアップから個人設定を読み取る。
 * 形式が合わない項目は捨てて既定値にする（壊れたデータで判定が止まらないようにするため）
 */
export function normalizeSettings(value: unknown): Settings {
  const s = defaultSettings();
  if (!isRecord(value)) return s;

  if (isRecord(value.point_values_milliyen)) {
    for (const [id, v] of Object.entries(value.point_values_milliyen)) {
      if (isText(id) && isIntIn(v, 0, MAX_POINT_VALUE_MILLIYEN)) s.point_values_milliyen[id] = v;
    }
  }
  if (isIntIn(value.annual_threshold_yen, 0, MAX_THRESHOLD_YEN)) s.annual_threshold_yen = value.annual_threshold_yen;
  if (isRecord(value.annual_period_start)) {
    for (const [id, v] of Object.entries(value.annual_period_start)) {
      if (isText(id) && isRecord(v) && isIntIn(v.month, 1, 12) && isIntIn(v.day, 1, 28)) {
        s.annual_period_start[id] = { month: v.month, day: v.day };
      }
    }
  }
  s.disabled_method_ids = textList(value.disabled_method_ids);
  s.favorite_store_ids = textList(value.favorite_store_ids);
  if (Array.isArray(value.custom_stores)) {
    const seen = new Set<string>();
    for (const v of value.custom_stores.slice(0, MAX_LIST_LENGTH)) {
      if (!isRecord(v) || typeof v.id !== "string" || !CUSTOM_STORE_ID.test(v.id) || seen.has(v.id) || !isText(v.name)) continue;
      seen.add(v.id);
      s.custom_stores.push({
        id: v.id,
        name: v.name.trim(),
        aliases: textList(v.aliases),
        channel: v.channel === "online" ? "online" : "in_store",
      });
    }
  }
  s.extra_aliases = textListRecord(value.extra_aliases);
  if (Array.isArray(value.store_exceptions)) {
    for (const v of value.store_exceptions.slice(0, MAX_LIST_LENGTH)) {
      if (isRecord(v) && isText(v.store_id) && isText(v.rule_id)) {
        s.store_exceptions.push({ store_id: v.store_id, rule_id: v.rule_id });
      }
    }
  }
  s.unusable_methods = textListRecord(value.unusable_methods);
  s.enabled_service_ids = textList(value.enabled_service_ids);
  if (Array.isArray(value.custom_services)) {
    const seen = new Set<string>();
    for (const v of value.custom_services.slice(0, MAX_LIST_LENGTH)) {
      if (!isRecord(v) || typeof v.id !== "string" || !CUSTOM_SERVICE_ID.test(v.id) || seen.has(v.id) || !isText(v.name)) continue;
      seen.add(v.id);
      s.custom_services.push({
        id: v.id,
        name: v.name.trim(),
        store_ids: textList(v.store_ids),
        url: typeof v.url === "string" && isHttpsUrl(v.url) ? v.url : null,
      });
    }
  }
  return s;
}

/** 追加する店舗の id を、既存と重ならないように作る */
export function newCustomStoreId(existing_ids: readonly string[]): string {
  const used = new Set(existing_ids);
  for (let n = 1; ; n += 1) {
    const id = `user_store_${n}`;
    if (!used.has(id)) return id;
  }
}

/** 追加するサービスの id を、既存と重ならないように作る */
export function newCustomServiceId(existing_ids: readonly string[]): string {
  const used = new Set(existing_ids);
  for (let n = 1; ; n += 1) {
    const id = `user_service_${n}`;
    if (!used.has(id)) return id;
  }
}

export interface MergeResult {
  rules: Rules;
  /** 合成後のルールに問題があった場合の説明（このとき rules は公式ルールのまま） */
  errors: string[];
}

/** 公式ルールに個人設定を合成する。存在しない id を指す設定は無視する */
export function mergeRules(official: Rules, settings: Settings): MergeResult {
  const rules = structuredClone(official);

  for (const point of rules.points) {
    const value = settings.point_values_milliyen[point.id];
    if (value !== undefined) point.value_milliyen = value;
  }

  const store_ids = new Set(rules.stores.map((s) => s.id));
  for (const custom of settings.custom_stores) {
    if (store_ids.has(custom.id)) continue;
    store_ids.add(custom.id);
    const store: Store = { id: custom.id, name: custom.name, aliases: [...custom.aliases] };
    if (custom.channel === "online") store.channel = "online";
    rules.stores.push(store);
  }

  const method_ids = new Set(rules.methods.map((m) => m.id));
  for (const store of rules.stores) {
    const aliases = settings.extra_aliases[store.id];
    if (aliases) store.aliases = [...new Set([...store.aliases, ...aliases])];
    const unusable = (settings.unusable_methods[store.id] ?? []).filter((id) => method_ids.has(id));
    if (unusable.length > 0) {
      store.unusable_method_ids = [...new Set([...(store.unusable_method_ids ?? []), ...unusable])];
    }
  }

  const all_rewards = [...rules.cards.flatMap((c) => c.rewards), ...rules.methods.flatMap((m) => m.rewards ?? [])];
  for (const exception of settings.store_exceptions) {
    const rule = all_rewards.find((r) => r.id === exception.rule_id);
    if (!rule || !store_ids.has(exception.store_id)) continue;
    const excluded = rule.applies.exclude_store_ids ?? [];
    if (!excluded.includes(exception.store_id)) rule.applies.exclude_store_ids = [...excluded, exception.store_id];
  }

  for (const card of rules.cards) {
    const start = settings.annual_period_start[card.id];
    if (card.annual_target && start) {
      card.annual_target.period_start_month = start.month;
      card.annual_target.period_start_day = start.day;
    }
  }

  const errors = checkIntegrity(rules);
  return errors.length > 0 ? { rules: official, errors } : { rules, errors: [] };
}

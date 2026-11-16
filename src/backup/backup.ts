// バックアップ：個人設定と利用記録を1つの JSON にまとめる／読み戻す
// アクセストークンとルールの取得先は含めない（メールで送るファイルのため。復元後に設定画面で入力し直す）

import { daysBetween, toEpochDay } from "../engine/dates";
import { MAX_AMOUNT_YEN } from "../engine/recommend";
import { normalizeSettings, type Settings } from "../settings/settings";
import type { SpendEntry } from "../storage/db";

/** バックアップに入れる利用記録（端末内の通し番号は含めない） */
export type BackupSpend = Omit<SpendEntry, "id">;

export interface BackupFile {
  format: "pay-app-backup";
  version: 1;
  /** 書き出した時刻（ISO 8601） */
  exported_at: string;
  settings: Settings;
  spend: BackupSpend[];
}

/** 読み込み前に画面へ出す要約 */
export interface BackupSummary {
  exported_at: string;
  spend_count: number;
  /** 記録の最初と最後の日付（記録がなければ null） */
  first_date: string | null;
  last_date: string | null;
  /** 記録の金額の合計 [円] */
  total_yen: number;
  favorite_count: number;
  custom_store_count: number;
  disabled_method_count: number;
}

export type ParsedBackup =
  | { ok: true; backup: BackupFile; summary: BackupSummary }
  | { ok: false; message: string };

/** この日数以上バックアップしていなければ、書き出しを促す [日] */
export const BACKUP_REMINDER_DAYS = 30;
const MAX_SPEND_ENTRIES = 100_000;
const MAX_NOTE_LENGTH = 300;

export function buildBackup(args: { settings: Settings; spend: readonly SpendEntry[]; now: Date }): BackupFile {
  return {
    format: "pay-app-backup",
    version: 1,
    exported_at: args.now.toISOString(),
    settings: args.settings,
    spend: args.spend.map(({ id: _id, ...rest }) => rest),
  };
}

/** ファイル名（例：pay-app-backup-2026-01-10.json）。date は Asia/Tokyo の暦日 */
export function backupFileName(date: string, extension: "json" | "txt" = "json"): string {
  return `pay-app-backup-${date}.${extension}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIdOrNull = (v: unknown): v is string | null => v === null || (typeof v === "string" && v !== "" && v.length <= 100);

function isValidDate(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    toEpochDay(v);
    return true;
  } catch {
    return false;
  }
}

function parseSpend(v: unknown): BackupSpend | null {
  if (!isRecord(v)) return null;
  const { date, amount_yen, kind, method_id, annual_card_id, note, created_at } = v;
  if (!isValidDate(date)) return null;
  if (typeof amount_yen !== "number" || !Number.isSafeInteger(amount_yen) || Math.abs(amount_yen) > MAX_AMOUNT_YEN) return null;
  if (kind !== "payment" && kind !== "adjustment") return null;
  if (!isIdOrNull(method_id) || !isIdOrNull(annual_card_id)) return null;
  if (note !== undefined && (typeof note !== "string" || note.length > MAX_NOTE_LENGTH)) return null;
  if (typeof created_at !== "string" || Number.isNaN(Date.parse(created_at))) return null;
  const entry: BackupSpend = { date, amount_yen, kind, method_id, annual_card_id, created_at };
  if (note !== undefined) entry.note = note;
  return entry;
}

/** バックアップのファイル内容を読み取り、検査する。1件でも読めない記録があれば全体を不合格にする */
export function parseBackup(text: string): ParsedBackup {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, message: "ファイルを JSON として読めません。" };
  }
  if (!isRecord(data) || data.format !== "pay-app-backup") {
    return { ok: false, message: "このアプリのバックアップファイルではありません。" };
  }
  if (data.version !== 1) return { ok: false, message: "このバックアップの形式には対応していません（新しいアプリで作られた可能性があります）。" };
  if (typeof data.exported_at !== "string" || Number.isNaN(Date.parse(data.exported_at))) {
    return { ok: false, message: "書き出し日時が読めません。" };
  }
  if (!Array.isArray(data.spend) || data.spend.length > MAX_SPEND_ENTRIES) {
    return { ok: false, message: "利用記録が読めません。" };
  }
  const spend: BackupSpend[] = [];
  for (const [index, raw] of data.spend.entries()) {
    const entry = parseSpend(raw);
    if (entry === null) return { ok: false, message: `利用記録の ${index + 1} 件目が読めません。` };
    spend.push(entry);
  }
  const settings = normalizeSettings(data.settings);
  const dates = spend.map((e) => e.date).sort();
  return {
    ok: true,
    backup: { format: "pay-app-backup", version: 1, exported_at: data.exported_at, settings, spend },
    summary: {
      exported_at: data.exported_at,
      spend_count: spend.length,
      first_date: dates[0] ?? null,
      last_date: dates[dates.length - 1] ?? null,
      total_yen: spend.reduce((sum, e) => sum + e.amount_yen, 0),
      favorite_count: settings.favorite_store_ids.length,
      custom_store_count: settings.custom_stores.length,
      disabled_method_count: settings.disabled_method_ids.length,
    },
  };
}

/**
 * バックアップを促すか。
 * last_backup_date は前回の書き出し日（Asia/Tokyo の暦日）。一度も無ければ null。
 * 守るデータ（利用記録）がまだ無いうちは促さない
 */
export function isBackupDue(last_backup_date: string | null, today: string, spend_count: number): boolean {
  if (spend_count === 0) return false;
  if (last_backup_date === null) return true;
  return daysBetween(last_backup_date, today) >= BACKUP_REMINDER_DAYS;
}

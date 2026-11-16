// 日付の計算。暦日は YYYY-MM-DD の文字列で持ち、判定は Asia/Tokyo 基準で行う（端末のタイムゾーンに依存させない）

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

const JST_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 時刻を Asia/Tokyo の暦日（YYYY-MM-DD）にする */
export function toJstDate(now: Date): string {
  const parts = JST_FORMAT.formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** 年・月・日から YYYY-MM-DD を作る */
export function formatDate(year: number, month: number, day: number): string {
  const pad = (n: number, width: number): string => String(n).padStart(width, "0");
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** YYYY-MM-DD を、1970-01-01 からの通算日にする。存在しない日付（2/30 など）は例外 */
export function toEpochDay(date: string): number {
  const m = DATE_PATTERN.exec(date);
  if (!m) throw new RangeError(`日付は YYYY-MM-DD で指定してください: ${date}`);
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new RangeError(`存在しない日付です: ${date}`);
  }
  return ms / MS_PER_DAY;
}

/** 通算日を YYYY-MM-DD にする */
export function fromEpochDay(epoch_day: number): string {
  const d = new Date(epoch_day * MS_PER_DAY);
  return formatDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** from から to までの日数 [日]（同じ日は 0、to が後なら正） */
export function daysBetween(from: string, to: string): number {
  return toEpochDay(to) - toEpochDay(from);
}

/** days 日後の日付（負の値で過去） */
export function addDays(date: string, days: number): string {
  return fromEpochDay(toEpochDay(date) + days);
}

/** 日付から年を取り出す */
export function yearOf(date: string): number {
  toEpochDay(date);
  return Number(date.slice(0, 4));
}

// バックアップ画面：書き出し（共有メニュー／ファイル保存）と、ファイルからの復元

import { useState } from "preact/hooks";
import { backupFileName, buildBackup, parseBackup, type BackupFile, type BackupSummary } from "../backup/backup";
import type { Settings } from "../settings/settings";
import type { SpendEntry } from "../storage/db";
import { formatDate, formatYen } from "./format";

interface Props {
  settings: Settings;
  spend: SpendEntry[];
  today: string;
  /** 前回の書き出し日（YYYY-MM-DD）。一度も無ければ null */
  last_backup_date: string | null;
  /** 書き出しが済んだことを記録する */
  onExported: () => Promise<void>;
  /** 端末内のデータを、バックアップの内容で置き換える */
  onRestore: (backup: BackupFile) => Promise<void>;
}

/** 共有メニューに渡せる形のファイルを作る。端末が受け付けなければ null */
function shareableFile(text: string, date: string): File | null {
  if (typeof navigator.canShare !== "function") return null;
  // JSON を共有できない端末があるので、だめならテキストファイルとして渡す（中身は同じ）
  const candidates = [
    new File([text], backupFileName(date, "json"), { type: "application/json" }),
    new File([text], backupFileName(date, "txt"), { type: "text/plain" }),
  ];
  return candidates.find((file) => navigator.canShare({ files: [file] })) ?? null;
}

export function Backup({ settings, spend, today, last_backup_date, onExported, onRestore }: Props) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ backup: BackupFile; summary: BackupSummary } | null>(null);

  const text = () => JSON.stringify(buildBackup({ settings, spend, now: new Date() }), null, 2);
  const can_share = shareableFile("{}", today) !== null;

  const share = async () => {
    setError(null);
    const file = shareableFile(text(), today);
    if (file === null) return;
    try {
      await navigator.share({ files: [file], title: "支払い手段おすすめ バックアップ" });
    } catch (e) {
      // 共有メニューを閉じただけなら、何もしない
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError("共有できませんでした。「ファイルに保存」を使ってください。");
      return;
    }
    await onExported();
    setMessage("バックアップを共有しました。");
  };

  const download = async () => {
    setError(null);
    const url = URL.createObjectURL(new Blob([text()], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = backupFileName(today);
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    await onExported();
    setMessage("バックアップをファイルに保存しました。");
  };

  const choose = async (file: File | undefined) => {
    setMessage(null);
    setPending(null);
    if (!file) return;
    const parsed = parseBackup(await file.text());
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setError(null);
    setPending({ backup: parsed.backup, summary: parsed.summary });
  };

  const restore = async () => {
    if (pending === null) return;
    await onRestore(pending.backup);
    setPending(null);
    setMessage("バックアップから復元しました。");
  };

  return (
    <div class="screen">
      <section class="card">
        <h2>書き出し</h2>
        <p class="hint">
          前回の書き出し：{last_backup_date ? formatDate(last_backup_date) : "まだありません"}／利用記録 {spend.length} 件
        </p>
        {can_share && (
          <button type="button" class="primary" onClick={() => void share()}>
            共有する（メールなどで送る）
          </button>
        )}
        <button type="button" class="secondary" onClick={() => void download()}>
          ファイルに保存
        </button>
        <p class="hint">
          個人設定と利用記録を1つのファイルにまとめます。アクセストークンとルールの取得先は含めません。
        </p>
      </section>

      <section class="card">
        <h2>
          <label for="restore-file">復元（ファイルから読み込む）</label>
        </h2>
        <input
          id="restore-file"
          class="input"
          type="file"
          accept=".json,.txt,application/json,text/plain"
          onChange={(e) => {
            void choose(e.currentTarget.files?.[0]);
            e.currentTarget.value = "";
          }}
        />
        {pending && (
          <div class="banner banner-info">
            <strong>このファイルの内容</strong>
            <ul>
              <li>書き出し日時：{new Date(pending.summary.exported_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</li>
              <li>
                利用記録：{pending.summary.spend_count} 件
                {pending.summary.first_date && pending.summary.last_date
                  ? `（${formatDate(pending.summary.first_date)} 〜 ${formatDate(pending.summary.last_date)}、合計 ${formatYen(pending.summary.total_yen)}）`
                  : ""}
              </li>
              <li>
                お気に入り {pending.summary.favorite_count} 件、追加した店舗 {pending.summary.custom_store_count} 件、無効にした手段{" "}
                {pending.summary.disabled_method_count} 件
              </li>
            </ul>
            <p>
              今この端末にある個人設定と利用記録（{spend.length} 件）は、この内容に置き換わります。元には戻せません。
            </p>
            <button type="button" class="primary" onClick={() => void restore()}>
              この内容で置き換える
            </button>
            <button type="button" class="link" onClick={() => setPending(null)}>
              やめる
            </button>
          </div>
        )}
      </section>

      {error && <p class="banner banner-error">{error}</p>}
      {message && <p class="banner banner-ok">{message}</p>}
    </div>
  );
}

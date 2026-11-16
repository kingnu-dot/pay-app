// 判定結果を文章にする（画面に出す文言をここに集め、テストできるようにする）

import type { Notice, Recommendation, RedemptionNotice } from "../engine/advise";
import type { RewardComponent } from "../engine/recommend";
import type { SyncProblem } from "../rules/sync";
import { formatCap, formatDate, formatMilliyen, formatRate, formatYen } from "./format";

/** 内訳1行：金額 × 付与率 × ポイント価値（端数処理後）が分かるようにする */
export function breakdownLine(c: RewardComponent, amount_yen: number | null): string {
  const label = c.source === "charge" ? `チャージ時：${c.label}` : c.label;
  if (c.basis === "actual" && c.points !== null && c.value_milliyen !== null) {
    return `${label}：${c.points.toLocaleString("ja-JP")} ${c.point_name} × ${formatMilliyen(c.point_value_milliyen)} ＝ ${formatMilliyen(c.value_milliyen)}`;
  }
  if (c.basis === "expected" && amount_yen !== null && c.value_milliyen !== null) {
    return `${label}：${formatYen(amount_yen)} × ${formatRate(c.rate_ppm)}（${c.point_name}、期待値）＝ ${formatMilliyen(c.value_milliyen)}`;
  }
  return `${label}：${formatRate(c.rate_ppm)}（${c.point_name}）`;
}

/** 1位の理由（1〜2行） */
export function reasonText(rec: Recommendation): string {
  const top = rec.advices[0];
  if (!top) return "この店で使える支払い手段がありません。";
  if (rec.promotion) {
    return `年間目標の達成ペース確保のため（還元が最大の手段との差は ${formatMilliyen(rec.promotion.diff_milliyen)}）。`;
  }
  const { candidate } = top;
  if (candidate.components.length === 0 || candidate.rate_ppm === 0) return "どの支払い手段にも還元がありません。";
  const labels = candidate.components.map((c) => c.label).join("＋");
  const second = rec.advices[1]?.candidate;
  if (candidate.total_milliyen === null) return `還元率が最大（${labels}）。`;
  if (!second || second.total_milliyen === null) return `還元が最大（${labels}）。`;
  const diff = candidate.total_milliyen - second.total_milliyen;
  return diff === 0
    ? `還元が最大（${labels}）。2位と同額です。`
    : `還元が最大（${labels}）。2位との差は ${formatMilliyen(diff)}。`;
}

/** 注意事項1件の文言 */
export function noticeText(n: Notice): string {
  switch (n.kind) {
    case "method_warning":
      return n.text;
    case "unverified":
      return `「${n.label}」は公式情報で未確認です。`;
    case "stale":
      return `「${n.label}」は要再確認（最終確認 ${formatDate(n.last_verified)}）。`;
    case "cap":
      return `「${n.label}」には上限があります（${formatCap(n.cap)}）。`;
  }
}

/** ポイント利用の案内の補足（使うポイント数と残額） */
export function redemptionDetail(r: RedemptionNotice): string | null {
  if (r.use_points === null || r.covered_yen === null || r.remainder_yen === null) {
    return r.cap_points === null ? null : `上限 ${r.cap_points.toLocaleString("ja-JP")} ${r.point_name}`;
  }
  const used = `${r.use_points.toLocaleString("ja-JP")} ${r.point_name}で ${formatYen(r.covered_yen)}分`;
  const rest = r.remainder_yen > 0 ? `。残り ${formatYen(r.remainder_yen)}は下の手段で` : "";
  const daily = r.cap_period === "day" ? "（上限は1日あたり。同じ日に使った分があれば差し引く）" : "";
  return `${used}${rest}${daily}`;
}

/** ルール取得の問題を、画面に出す文言にする。表示不要なら null */
export function problemText(problem: SyncProblem | null, has_rules: boolean): string | null {
  if (problem === null) return null;
  const fallback = has_rules ? "保存済みのルールで動作しています。" : "";
  switch (problem.kind) {
    case "not_configured":
      return has_rules ? null : "設定画面で、ルールの取得先とアクセストークンを入力してください。";
    case "unauthorized":
      return `トークンを更新してください（無効または期限切れ）。${fallback}`;
    case "forbidden":
      return `トークンの権限が不足しています。${fallback}`;
    case "not_found":
      return `ルールのファイルが見つかりません。取得先とトークンの対象リポジトリを確認してください。${fallback}`;
    case "rate_limited":
      return `利用回数の制限中です。しばらくしてから再取得してください。${fallback}`;
    case "http_error":
      return `ルールを取得できませんでした（状態コード ${problem.code}）。${fallback}`;
    case "network_error":
      return has_rules ? "オフラインです。保存済みのルールで動作しています。" : "ルールを取得できませんでした（通信エラー）。";
    case "invalid":
      return `新しいルールに誤りがあるため、反映していません。${fallback}（${problem.errors.slice(0, 3).join(" / ")}）`;
    case "cache_invalid":
      return `保存済みのルールがこのアプリの形式に合いません。再取得してください。（${problem.errors.slice(0, 3).join(" / ")}）`;
  }
}

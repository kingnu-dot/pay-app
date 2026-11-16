// 年間目標の画面：達成ペースの表示、累計の補正入力、利用記録の一覧

import { useState } from "preact/hooks";
import { annualPeriod, annualStatus } from "../engine/annual";
import type { Card, Rules } from "../rules/types";
import type { SpendEntry } from "../storage/db";
import { formatDate, formatYen, parseAmount } from "./format";

interface Props {
  rules: Rules;
  today: string;
  spend: SpendEntry[];
  /** カードごとの今期の年間利用額 [円] */
  annual_spent_yen: Record<string, number>;
  /** 累計を上書き入力する（差額を補正として記録する） */
  onSetTotal: (card_id: string, entered_total_yen: number) => Promise<void>;
  onDeleteEntry: (id: number) => Promise<void>;
}

/** 一覧に出す記録の件数 */
const MAX_ENTRIES = 30;

export function Annual({ rules, today, spend, annual_spent_yen, onSetTotal, onDeleteEntry }: Props) {
  const cards = rules.cards.filter((c) => c.annual_target);
  const recent = [...spend].reverse().slice(0, MAX_ENTRIES);

  return (
    <div class="screen">
      {cards.length === 0 && <p class="hint">年間目標のあるカードがありません。</p>}
      {cards.map((card) => (
        <TargetCard
          key={card.id}
          card={card}
          today={today}
          spent_yen={annual_spent_yen[card.id] ?? 0}
          onSetTotal={onSetTotal}
        />
      ))}

      <section class="card">
        <h2>利用記録（新しい順、{recent.length} 件表示／全 {spend.length} 件）</h2>
        {recent.length === 0 && <p class="hint">まだ記録がありません。ホームの「これで払った」で記録できます。</p>}
        <ul class="entries">
          {recent.map((e) => (
            <li key={e.id}>
              <div>
                <strong>{e.amount_yen < 0 ? `−${formatYen(-e.amount_yen)}` : formatYen(e.amount_yen)}</strong>
                <span class="entry-date">{formatDate(e.date)}</span>
                {e.kind === "adjustment" && <span class="tag"> 補正</span>}
                {e.annual_card_id === null && <span class="tag"> 集計対象外</span>}
              </div>
              {e.note && <div class="entry-note">{e.note}</div>}
              <button
                type="button"
                class="link"
                onClick={() => {
                  if (e.id !== undefined && confirm("この記録を削除しますか？")) void onDeleteEntry(e.id);
                }}
              >
                削除
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function TargetCard(props: {
  card: Card;
  today: string;
  spent_yen: number;
  onSetTotal: (card_id: string, entered_total_yen: number) => Promise<void>;
}) {
  const { card, today, spent_yen } = props;
  const [total_text, setTotalText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const target = card.annual_target;
  if (!target) return null;

  const period = annualPeriod(today, target.period_start_month, target.period_start_day);
  const status = annualStatus({ target_yen: target.target_yen, spent_yen, date: today, period });
  const percent = Math.min(100, Math.floor((Math.max(spent_yen, 0) * 100) / target.target_yen));
  const entered = parseAmount(total_text);

  const submit = async () => {
    if (!entered.ok || entered.amount_yen === null) return;
    await props.onSetTotal(card.id, entered.amount_yen);
    setMessage(`累計を ${formatYen(entered.amount_yen)} に合わせました。`);
    setTotalText("");
  };

  return (
    <section class="card">
      <h2>
        {card.name}：年間目標 {formatYen(target.target_yen)}
      </h2>
      <p class="hint">
        集計期間 {formatDate(period.start)} 〜 {formatDate(period.end)}
      </p>
      <div class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div class="progress-bar" style={{ width: `${percent}%` }} />
      </div>
      <dl class="stats">
        <dt>今期の累計</dt>
        <dd>
          {formatYen(spent_yen)}（{percent}%）
        </dd>
        <dt>残額</dt>
        <dd>{formatYen(status.remaining_yen)}</dd>
        <dt>残り日数</dt>
        <dd>{status.remaining_days} 日（今日を含む）</dd>
        <dt>1日あたり必要額</dt>
        <dd>{formatYen(status.required_per_day_yen)}</dd>
        <dt>今日までの目安</dt>
        <dd>{formatYen(status.pace_yen)}</dd>
      </dl>
      <p class={`banner ${status.achieved ? "banner-ok" : status.behind ? "banner-warn" : "banner-ok"}`}>
        {status.achieved
          ? "目標を達成しました。"
          : status.behind
            ? `達成ペースより ${formatYen(Math.max(status.pace_yen - Math.max(spent_yen, 0), 1))}ほど遅れています。`
            : "達成ペースを上回っています。"}
      </p>

      <h2>
        <label for={`total-${card.id}`}>累計を合わせる（カード会社の明細の金額を入力）</label>
      </h2>
      <div class="amount">
        <input
          id={`total-${card.id}`}
          class="input"
          type="text"
          inputMode="numeric"
          autocomplete="off"
          placeholder="今期の累計"
          value={total_text}
          onInput={(e) => {
            setTotalText(e.currentTarget.value);
            setMessage(null);
          }}
        />
        <span>円</span>
      </div>
      {!entered.ok && <p class="error">{entered.message}</p>}
      <button
        type="button"
        class="secondary"
        disabled={!entered.ok || entered.amount_yen === null}
        onClick={() => void submit()}
      >
        この金額に合わせる
      </button>
      <p class="hint">記録は消さず、差額を「補正」として追加します。</p>
      {message && <p class="banner banner-ok">{message}</p>}
    </section>
  );
}

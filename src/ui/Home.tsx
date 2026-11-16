// ホーム画面：店舗と金額を選ぶと、1画面でおすすめの支払い手段が分かる

import { useMemo, useState } from "preact/hooks";
import type { ActiveService, Coupon } from "../coupons/coupons";
import { recommend, ruleAlerts, type Advice, type Recommendation } from "../engine/advise";
import { searchStores } from "../engine/search";
import type { Rules, Store } from "../rules/types";
import type { Settings } from "../settings/settings";
import { breakdownLine, noticeText, reasonText, redemptionDetail } from "./explain";
import { formatDate, formatMilliyen, formatRate, formatYen, parseAmount } from "./format";
import { ExpiringCoupons, StorePerks } from "./Perks";

/** 「これで払った」で記録する内容 */
export interface PaidRecord {
  method_id: string;
  method_label: string;
  amount_yen: number;
  store_name: string;
  /** 年間利用額に計上するカード（計上しない決済は null） */
  annual_card_id: string | null;
}

interface Props {
  /** 公式ルールに個人設定を合成したルール */
  rules: Rules;
  settings: Settings;
  /** 今日の日付（YYYY-MM-DD、Asia/Tokyo） */
  today: string;
  /** カードごとの今期の年間利用額 [円] */
  annual_spent_yen: Record<string, number>;
  /** 期限が近いクーポン（画面の上部に出す） */
  expiring_coupons: Coupon[];
  /** その店で使えるクーポンを返す */
  couponsFor: (store_id: string | null) => Coupon[];
  /** 利用中のサービス */
  services: ActiveService[];
  onCouponUsed: (coupon_id: string) => void;
  onOpenCoupons: () => void;
  onToggleFavorite: (store_id: string) => void;
  onPaid: (record: PaidRecord) => Promise<void>;
}

/** 候補に一度に出す店舗の数 */
const MAX_STORE_CHOICES = 8;

/** 選択中の店舗。未選択は undefined、未登録の店（一般加盟店）は null */
type Selection = string | null | undefined;

export function Home(props: Props) {
  const { rules, settings, today, annual_spent_yen, onToggleFavorite, onPaid } = props;
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<Selection>(undefined);
  const [amount_text, setAmountText] = useState("");
  const [paid_message, setPaidMessage] = useState<string | null>(null);

  const amount = parseAmount(amount_text);
  const store = selection ? (rules.stores.find((s) => s.id === selection) ?? null) : null;
  const choices = useMemo(
    () => searchStores(rules.stores, query, settings.favorite_store_ids).slice(0, MAX_STORE_CHOICES),
    [rules, query, settings.favorite_store_ids],
  );
  const alerts = useMemo(() => ruleAlerts(rules, today), [rules, today]);

  const result: Recommendation | null = useMemo(() => {
    if (selection === undefined || !amount.ok) return null;
    return recommend({
      rules,
      store_id: selection,
      amount_yen: amount.amount_yen,
      date: today,
      disabled_method_ids: settings.disabled_method_ids,
      annual_spent_yen,
      annual_threshold_yen: settings.annual_threshold_yen,
    });
    // amount は毎回作り直されるオブジェクトなので、元の文字列（amount_text）を依存に使う
  }, [rules, selection, amount_text, today, settings, annual_spent_yen]);

  const select = (next: Selection) => {
    setSelection(next);
    setQuery("");
    setPaidMessage(null);
  };

  const pay = async (advice: Advice) => {
    if (!amount.ok || amount.amount_yen === null) return;
    const method = advice.candidate.method;
    await onPaid({
      method_id: method.id,
      method_label: method.label,
      amount_yen: amount.amount_yen,
      store_name: store?.name ?? "未登録の店",
      annual_card_id: method.counts_toward_annual ? (method.card_id ?? method.funding?.card_id ?? null) : null,
    });
    setPaidMessage(`${formatYen(amount.amount_yen)}を「${method.label}」で記録しました。`);
    setAmountText("");
  };

  return (
    <div class="screen">
      <ExpiringCoupons coupons={props.expiring_coupons} today={today} onOpen={props.onOpenCoupons} />
      {alerts.length > 0 && (
        <details class="banner banner-warn">
          <summary>
            ルールの確認：まもなく終了 {alerts.filter((a) => a.kind === "expiring").length} 件、要再確認{" "}
            {alerts.filter((a) => a.kind === "stale").length} 件
          </summary>
          <ul>
            {alerts.map((a) => (
              <li key={`${a.kind}:${a.where}`}>
                {a.kind === "expiring"
                  ? `まもなく終了：${a.label}（${formatDate(a.date)} まで、あと ${a.days} 日）`
                  : `要再確認：${a.label}（最終確認 ${formatDate(a.date)}、${a.days} 日前）`}
              </li>
            ))}
          </ul>
        </details>
      )}

      <section class="card">
        <h2>店舗</h2>
        {selection === undefined ? (
          <>
            <input
              type="search"
              class="input"
              placeholder="店名で検索"
              value={query}
              onInput={(e) => setQuery(e.currentTarget.value)}
              aria-label="店名で検索"
            />
            <div class="choices">
              {choices.map((s) => (
                <button key={s.id} type="button" class="choice" onClick={() => select(s.id)}>
                  {settings.favorite_store_ids.includes(s.id) ? "★ " : ""}
                  {s.name}
                </button>
              ))}
              <button type="button" class="choice choice-plain" onClick={() => select(null)}>
                未登録の店（一般加盟店）
              </button>
            </div>
            {query !== "" && choices.length === 0 && <p class="hint">一致する店舗がありません。</p>}
          </>
        ) : (
          <div class="selected">
            <strong>{store?.name ?? "未登録の店（一般加盟店）"}</strong>
            {store && <FavoriteButton store={store} settings={settings} onToggle={onToggleFavorite} />}
            <button type="button" class="link" onClick={() => select(undefined)}>
              変更
            </button>
            {store?.notes && store.notes.length > 0 && (
              <ul class="store-notes">
                {store.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section class="card">
        <h2>
          <label for="amount">金額（任意）</label>
        </h2>
        <div class="amount">
          <input
            id="amount"
            class="input"
            type="text"
            inputMode="numeric"
            autocomplete="off"
            placeholder="未入力なら還元率で比較"
            value={amount_text}
            onInput={(e) => {
              setAmountText(e.currentTarget.value);
              setPaidMessage(null);
            }}
          />
          <span>円</span>
        </div>
        {!amount.ok && <p class="error">{amount.message}</p>}
      </section>

      {paid_message && <p class="banner banner-ok">{paid_message}</p>}
      {selection === undefined && <p class="hint">店舗を選ぶと、おすすめの支払い手段を表示します。</p>}
      {result && (
        <Result result={result} amount_yen={amount.ok ? amount.amount_yen : null} rules={rules} onPay={pay} />
      )}
      {selection !== undefined && (
        <StorePerks
          store_id={selection}
          store_name={store?.name ?? null}
          coupons={props.couponsFor(selection)}
          services={props.services}
          today={today}
          onUsed={props.onCouponUsed}
        />
      )}
    </div>
  );
}

function FavoriteButton(props: { store: Store; settings: Settings; onToggle: (store_id: string) => void }) {
  const on = props.settings.favorite_store_ids.includes(props.store.id);
  return (
    <button
      type="button"
      class="link"
      aria-pressed={on}
      onClick={() => props.onToggle(props.store.id)}
    >
      {on ? "★ お気に入り" : "☆ お気に入りに追加"}
    </button>
  );
}

function Result(props: {
  result: Recommendation;
  amount_yen: number | null;
  rules: Rules;
  onPay: (advice: Advice) => Promise<void>;
}) {
  const { result, amount_yen, rules } = props;
  const [top, ...others] = result.advices;
  const cardName = (card_id: string): string => rules.cards.find((c) => c.id === card_id)?.name ?? card_id;

  return (
    <>
      {result.redemptions.map((r) => (
        <section key={r.redemption.id} class="banner banner-info">
          <strong>{r.redemption.text}</strong>
          {redemptionDetail(r) && <div>{redemptionDetail(r)}</div>}
        </section>
      ))}

      {top ? (
        <section class="card card-top">
          <div class="rank">おすすめ</div>
          <div class="method">{top.candidate.method.label}</div>
          <div class="reward">
            {top.candidate.total_milliyen !== null && (
              <span class="reward-yen">{formatMilliyen(top.candidate.total_milliyen)}</span>
            )}
            <span class="reward-rate">還元率 {formatRate(top.candidate.rate_ppm)}</span>
          </div>
          {result.loyalty.length > 0 && (
            <div class="loyalty">
              <span class="tag">提示するポイントカード</span>
              <ul>
                {result.loyalty.map((l) => (
                  <li key={l.label}>
                    {l.label}
                    {l.note ? `（${l.note}）` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p class="reason">{reasonText(result)}</p>
          <Breakdown advice={top} amount_yen={amount_yen} />
          <Notices advice={top} />
          {result.pace_alert_card_ids.map((card_id) => (
            <p key={card_id} class="notice">
              {cardName(card_id)}は年間目標のペースより遅れています。
            </p>
          ))}
          {amount_yen !== null && amount_yen > 0 && (
            <button type="button" class="primary" onClick={() => void props.onPay(top)}>
              これで払った（{formatYen(amount_yen)}を記録）
            </button>
          )}
        </section>
      ) : (
        <p class="banner banner-warn">{reasonText(result)}</p>
      )}

      {others.length > 0 && (
        <details class="card">
          <summary>2位以下（{others.length} 件）</summary>
          <ol class="others" start={2}>
            {others.map((advice) => (
              <li key={advice.candidate.method.id}>
                <div class="other-head">
                  <span>{advice.candidate.method.label}</span>
                  <span>
                    {advice.candidate.total_milliyen !== null && `${formatMilliyen(advice.candidate.total_milliyen)} / `}
                    {formatRate(advice.candidate.rate_ppm)}
                  </span>
                </div>
                <Breakdown advice={advice} amount_yen={amount_yen} />
                <Notices advice={advice} />
                {amount_yen !== null && amount_yen > 0 && (
                  <button type="button" class="link" onClick={() => void props.onPay(advice)}>
                    こちらで払った
                  </button>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
    </>
  );
}

function Breakdown(props: { advice: Advice; amount_yen: number | null }) {
  const { components } = props.advice.candidate;
  if (components.length === 0) return <p class="breakdown">還元なし</p>;
  return (
    <ul class="breakdown">
      {components.map((c) => (
        <li key={c.rule_id}>{breakdownLine(c, props.amount_yen)}</li>
      ))}
    </ul>
  );
}

function Notices(props: { advice: Advice }) {
  if (props.advice.notices.length === 0) return null;
  return (
    <ul class="notices">
      {props.advice.notices.map((n, i) => (
        <li key={i}>{noticeText(n)}</li>
      ))}
    </ul>
  );
}

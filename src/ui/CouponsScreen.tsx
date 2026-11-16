// クーポン画面：手動で登録したクーポン・優待の一覧、登録・編集、使用済み、カレンダー登録

import { useState } from "preact/hooks";
import {
  MAX_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
  activeCoupons,
  archivedCoupons,
  newCouponId,
  type ActiveService,
  type Coupon,
} from "../coupons/coupons";
import { calendarDate, calendarUrl } from "../coupons/links";
import { toEpochDay } from "../engine/dates";
import type { Store } from "../rules/types";
import { formatDate } from "./format";
import { expiryText } from "./Perks";

interface Props {
  coupons: Coupon[];
  stores: Store[];
  services: ActiveService[];
  today: string;
  /** クーポンの一覧を保存する */
  onSave: (next: Coupon[]) => Promise<void>;
}

/** 入力中の内容 */
interface Draft {
  /** 編集中のクーポンの id。新規は null */
  id: string | null;
  title: string;
  expires: string;
  conditions: string;
  store_ids: string[];
  service_id: string;
  memo: string;
}

const emptyDraft = (): Draft => ({ id: null, title: "", expires: "", conditions: "", store_ids: [], service_id: "", memo: "" });

function isValidDate(text: string): boolean {
  try {
    toEpochDay(text);
    return true;
  } catch {
    return false;
  }
}

export function CouponsScreen({ coupons, stores, services, today, onSave }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = activeCoupons(coupons, today);
  const archived = archivedCoupons(coupons, today);
  const storeNames = (ids: readonly string[]): string[] =>
    ids.map((id) => stores.find((s) => s.id === id)?.name).filter((n): n is string => n !== undefined);

  const submit = async () => {
    if (draft === null) return;
    const title = draft.title.trim();
    if (title === "" || title.length > MAX_TITLE_LENGTH) {
      setError(`名前を入力してください（${MAX_TITLE_LENGTH} 文字まで）`);
      return;
    }
    if (draft.expires !== "" && !isValidDate(draft.expires)) {
      setError("期限の日付が正しくありません");
      return;
    }
    if (draft.conditions.length > MAX_TEXT_LENGTH || draft.memo.length > MAX_TEXT_LENGTH) {
      setError(`条件とメモは ${MAX_TEXT_LENGTH} 文字までです`);
      return;
    }
    setError(null);
    const fields = {
      title,
      expires: draft.expires === "" ? null : draft.expires,
      conditions: draft.conditions.trim(),
      store_ids: draft.store_ids,
      service_id: draft.service_id === "" ? null : draft.service_id,
      memo: draft.memo.trim(),
    };
    const next =
      draft.id === null
        ? [...coupons, { ...fields, id: newCouponId(coupons), used: false, created_at: new Date().toISOString() }]
        : coupons.map((c) => (c.id === draft.id ? { ...c, ...fields } : c));
    await onSave(next);
    setDraft(null);
  };

  const setUsed = (id: string, used: boolean) => void onSave(coupons.map((c) => (c.id === id ? { ...c, used } : c)));
  const remove = (coupon: Coupon) => {
    if (confirm(`「${coupon.title}」を削除しますか？`)) void onSave(coupons.filter((c) => c.id !== coupon.id));
  };
  const edit = (c: Coupon) => {
    setError(null);
    setDraft({
      id: c.id,
      title: c.title,
      expires: c.expires ?? "",
      conditions: c.conditions,
      store_ids: c.store_ids,
      service_id: c.service_id ?? "",
      memo: c.memo,
    });
  };

  const item = (c: Coupon, is_archived: boolean) => {
    const names = storeNames(c.store_ids);
    const service = services.find((s) => s.id === c.service_id);
    const calendar = is_archived ? null : calendarUrl(c, today, names);
    return (
      <li key={c.id} class="coupon">
        <strong>{c.title}</strong>
        <div class="perk-sub">
          {c.used ? "使用済み・" : ""}
          {expiryText(c, today)}
        </div>
        <div class="perk-sub">対象：{c.store_ids.length === 0 ? "店舗を限定しない" : names.join("、") || "（登録のない店舗）"}</div>
        {c.conditions && <div class="perk-sub">条件：{c.conditions}</div>}
        {service && <div class="perk-sub">サービス：{service.name}</div>}
        {c.memo && <div class="perk-sub">メモ：{c.memo}</div>}
        <div class="coupon-actions">
          {!is_archived && (
            <button type="button" class="link" onClick={() => setUsed(c.id, true)}>
              使った
            </button>
          )}
          {c.used && (
            <button type="button" class="link" onClick={() => setUsed(c.id, false)}>
              未使用に戻す
            </button>
          )}
          <button type="button" class="link" onClick={() => edit(c)}>
            編集
          </button>
          {calendar && c.expires && (
            <a class="perk-link" href={calendar} target="_blank" rel="noopener noreferrer">
              Google カレンダーに追加（{formatDate(calendarDate(c.expires, today))} の予定）
            </a>
          )}
          <button type="button" class="link danger" onClick={() => remove(c)}>
            削除
          </button>
        </div>
      </li>
    );
  };

  return (
    <div class="screen">
      {draft === null ? (
        <button
          type="button"
          class="primary"
          onClick={() => {
            setError(null);
            setDraft(emptyDraft());
          }}
        >
          クーポン・優待を登録
        </button>
      ) : (
        <section class="card">
          <h2>{draft.id === null ? "クーポン・優待を登録" : "クーポン・優待を編集"}</h2>
          <label class="field">
            名前
            <input class="input" type="text" value={draft.title} onInput={(e) => setDraft({ ...draft, title: e.currentTarget.value })} />
          </label>
          <label class="field">
            期限（空欄なら期限なし）
            <input class="input" type="date" value={draft.expires} onInput={(e) => setDraft({ ...draft, expires: e.currentTarget.value })} />
          </label>
          <label class="field">
            条件（任意。例：1,000 円以上で 100 円引き）
            <input
              class="input"
              type="text"
              value={draft.conditions}
              onInput={(e) => setDraft({ ...draft, conditions: e.currentTarget.value })}
            />
          </label>
          <details class="field-group" open={draft.store_ids.length > 0}>
            <summary>
              対象店舗：{draft.store_ids.length === 0 ? "店舗を限定しない" : `${draft.store_ids.length} 店舗を選択中`}
            </summary>
            {stores.map((s) => (
              <label key={s.id} class="check">
                <input
                  type="checkbox"
                  checked={draft.store_ids.includes(s.id)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      store_ids: e.currentTarget.checked ? [...draft.store_ids, s.id] : draft.store_ids.filter((id) => id !== s.id),
                    })
                  }
                />
                {s.name}
              </label>
            ))}
          </details>
          {services.length > 0 && (
            <label class="field">
              関連するサービス（任意）
              <select class="input" value={draft.service_id} onChange={(e) => setDraft({ ...draft, service_id: e.currentTarget.value })}>
                <option value="">なし</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label class="field">
            メモ（任意）
            <input class="input" type="text" value={draft.memo} onInput={(e) => setDraft({ ...draft, memo: e.currentTarget.value })} />
          </label>
          {error && <p class="error">{error}</p>}
          <button type="button" class="primary" onClick={() => void submit()}>
            保存
          </button>
          <button type="button" class="link" onClick={() => setDraft(null)}>
            やめる
          </button>
        </section>
      )}

      <section class="card">
        <h2>使えるクーポン・優待（{active.length} 件、期限の近い順）</h2>
        {active.length === 0 && <p class="hint">登録されたクーポンはありません。</p>}
        <ul class="coupons">{active.map((c) => item(c, false))}</ul>
      </section>

      {archived.length > 0 && (
        <details class="card">
          <summary>使用済み・期限切れ（{archived.length} 件）</summary>
          <ul class="coupons">{archived.map((c) => item(c, true))}</ul>
        </details>
      )}
    </div>
  );
}

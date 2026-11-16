// クーポン・優待の表示部品（ホーム画面とクーポン画面で使う）

import { daysLeft, servicesForStore, type ActiveService, type Coupon } from "../coupons/coupons";
import { appIntentUrl, playStoreUrl, searchUrl } from "../coupons/links";
import { formatDate } from "./format";

/** 期限の表示（例：1/31 まで・あと 3 日） */
export function expiryText(coupon: Coupon, today: string): string {
  const days = daysLeft(coupon, today);
  if (coupon.expires === null || days === null) return "期限なし";
  if (days < 0) return `${formatDate(coupon.expires)} で期限切れ`;
  return `${formatDate(coupon.expires)} まで・${days === 0 ? "今日まで" : `あと ${days} 日`}`;
}

/** ホーム画面の上部：期限が近いクーポン */
export function ExpiringCoupons(props: { coupons: Coupon[]; today: string; onOpen: () => void }) {
  if (props.coupons.length === 0) return null;
  return (
    <section class="banner banner-warn">
      <strong>期限が近いクーポン（{props.coupons.length} 件）</strong>
      <ul>
        {props.coupons.map((c) => (
          <li key={c.id}>
            {c.title}（{expiryText(c, props.today)}）
          </li>
        ))}
      </ul>
      <button type="button" class="link" onClick={props.onOpen}>
        クーポンを見る
      </button>
    </section>
  );
}

/** サービス1件のリンク（アプリを開く、ストアで見る、店名で検索、登録したページを開く） */
export function ServiceLinks(props: { service: ActiveService; store_name: string | null }) {
  const { service, store_name } = props;
  return (
    <span class="perk-links">
      {service.app && (
        <>
          <a class="perk-link" href={appIntentUrl(service.app)}>
            アプリを開く
          </a>
          <a class="perk-link" href={playStoreUrl(service.app.android_package)} target="_blank" rel="noopener noreferrer">
            ストアで見る
          </a>
        </>
      )}
      {service.search_url_template && store_name !== null && (
        <a class="perk-link" href={searchUrl(service.search_url_template, store_name)} target="_blank" rel="noopener noreferrer">
          「{store_name}」を検索
        </a>
      )}
      {service.url && (
        <a class="perk-link" href={service.url} target="_blank" rel="noopener noreferrer">
          ページを開く
        </a>
      )}
    </span>
  );
}

/** ホーム画面の判定結果の下：その店で使える可能性のあるクーポン・優待 */
export function StorePerks(props: {
  store_id: string | null;
  store_name: string | null;
  /** その店で使えるクーポン（絞り込み済み） */
  coupons: Coupon[];
  /** 利用中のサービス（全体） */
  services: ActiveService[];
  today: string;
  onUsed: (coupon_id: string) => void;
}) {
  const services = servicesForStore(props.services, props.store_id);
  if (props.coupons.length === 0 && services.length === 0) return null;
  return (
    <section class="card">
      <h2>クーポン・優待</h2>
      {props.coupons.length > 0 && (
        <ul class="perks">
          {props.coupons.map((c) => (
            <li key={c.id}>
              <div>
                <strong>{c.title}</strong>
                <div class="perk-sub">{expiryText(c, props.today)}</div>
                {c.conditions && <div class="perk-sub">条件：{c.conditions}</div>}
              </div>
              <button type="button" class="link" onClick={() => props.onUsed(c.id)}>
                使った
              </button>
            </li>
          ))}
        </ul>
      )}
      {services.length > 0 && (
        <ul class="perks">
          {services.map((s) => (
            <li key={s.id} class="perk-service">
              <div>
                <strong>{s.name}</strong>
                <div class="perk-sub">
                  {s.app ? "このアプリにクーポンがあるか確認" : "優待があるか確認"}
                  {s.note ? `（${s.note}）` : ""}
                </div>
              </div>
              <ServiceLinks service={s} store_name={props.store_name} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

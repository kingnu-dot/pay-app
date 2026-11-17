// 近くの店の表示部品（店名検索の「近くの支店」と、「現在地から探す」の一覧）

import { formatDistance, type MatchedPlace } from "../location/match";
import type { NearbyState } from "../location/useNearby";
import type { Store } from "../rules/types";

/** 一覧に出す件数の上限 */
const MAX_BRANCHES = 5;
const MAX_REGISTERED = 10;
const MAX_UNREGISTERED = 20;

/** 取得の状況（取得中・失敗）。失敗しても、検索結果からそのまま選べることを示す */
export function NearbyStatus(props: { state: NearbyState }) {
  const { status, message } = props.state;
  if (status === "locating") return <p class="hint">現在地を取得中…</p>;
  if (status === "loading") return <p class="hint">近くの店を検索中…（混雑時は 30 秒ほどかかります。下の候補からそのまま選べます）</p>;
  if (status === "error" && message) return <p class="hint">{message}</p>;
  return null;
}

/** 地図データの出典表示（OpenStreetMap の利用条件） */
export function OsmAttribution() {
  return (
    <p class="attribution">
      地図データ ©{" "}
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">
        OpenStreetMap contributors
      </a>
    </p>
  );
}

/** 店名検索の結果に対応する、近くの支店（距離の近い順） */
export function NearbyBranches(props: {
  matched: MatchedPlace[];
  /** 検索結果に出ている店舗 */
  store_ids: readonly string[];
  stores: readonly Store[];
  onSelect: (store_id: string) => void;
}) {
  const branches = props.matched.filter((m) => m.store_id !== null && props.store_ids.includes(m.store_id)).slice(0, MAX_BRANCHES);
  if (branches.length === 0) return null;
  return (
    <div class="nearby">
      <h3>近くの支店</h3>
      <ul class="nearby-list">
        {branches.map((m) => (
          <li key={m.place.id}>
            <button type="button" class="nearby-item" onClick={() => props.onSelect(m.store_id as string)}>
              <span>
                {m.place.name}
                <StoreSuffix place_name={m.place.name} store_id={m.store_id} stores={props.stores} />
              </span>
              <span class="distance">{formatDistance(m.distance_m)}</span>
            </button>
          </li>
        ))}
      </ul>
      <OsmAttribution />
    </div>
  );
}

/** 「現在地から探す」の結果：登録済み店舗と、登録されていない近くの店 */
export function NearbyStores(props: {
  matched: MatchedPlace[];
  stores: readonly Store[];
  onSelect: (store_id: string) => void;
  /** 登録されていない店を、未登録の店として判定する */
  onSelectUnregistered: (place_name: string) => void;
  /** 登録されていない店を、自分の店舗として追加する */
  onAdd: (place_name: string) => void;
}) {
  const registered = props.matched.filter((m) => m.store_id !== null).slice(0, MAX_REGISTERED);
  const unregistered = props.matched.filter((m) => m.store_id === null).slice(0, MAX_UNREGISTERED);
  return (
    <div class="nearby">
      <h3>近くの登録済み店舗</h3>
      {registered.length === 0 ? (
        <p class="hint">半径 300m 以内に、登録済みの店舗は見つかりませんでした。</p>
      ) : (
        <ul class="nearby-list">
          {registered.map((m) => (
            <li key={m.place.id}>
              <button type="button" class="nearby-item" onClick={() => props.onSelect(m.store_id as string)}>
                <span>
                  {m.place.name}
                  <StoreSuffix place_name={m.place.name} store_id={m.store_id} stores={props.stores} />
                </span>
                <span class="distance">{formatDistance(m.distance_m)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {unregistered.length > 0 && (
        <details class="field-group">
          <summary>登録されていない近くの店（{unregistered.length} 件）</summary>
          <ul class="nearby-list">
            {unregistered.map((m) => (
              <li key={m.place.id} class="nearby-unregistered">
                <span>
                  {m.place.name}
                  <span class="distance"> {formatDistance(m.distance_m)}</span>
                </span>
                <span class="perk-links">
                  <button type="button" class="link" onClick={() => props.onSelectUnregistered(m.place.name)}>
                    この店で判定
                  </button>
                  <button type="button" class="link" onClick={() => props.onAdd(m.place.name)}>
                    店舗に追加
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <OsmAttribution />
    </div>
  );
}

/** 地図上の名前と登録店舗の名前が違うとき、登録店舗の名前を添える */
function StoreSuffix(props: { place_name: string; store_id: string | null; stores: readonly Store[] }) {
  const name = props.stores.find((s) => s.id === props.store_id)?.name;
  if (name === undefined || props.place_name.startsWith(name)) return null;
  return <span class="perk-sub">（{name}）</span>;
}

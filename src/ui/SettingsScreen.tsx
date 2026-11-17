// 設定画面：ルールの取得設定と、個人上書き層（すべてフォームで編集する。JSON の直接編集は不要）

import { useEffect, useState } from "preact/hooks";
import { checkSource, isTokenFormatValid, type RulesSource } from "../rules/fetch";
import type { SyncResult } from "../rules/sync";
import type { RewardRule, Rules } from "../rules/types";
import { isSafeHttpsUrl } from "../coupons/links";
import {
  MAX_POINT_VALUE_MILLIYEN,
  MAX_THRESHOLD_YEN,
  isSuccessorRuleId,
  newCustomServiceId,
  newCustomStoreId,
  type Settings,
} from "../settings/settings";
import { clearNearbyCache, loadNearbyCache, type RulesConfig } from "../storage/db";
import { milliyenToInput, parseAmount, parseYenValue } from "./format";

interface Props {
  /** 公式ルール（個人設定を合成する前） */
  official: Rules;
  /** 合成後のルール */
  merged: Rules;
  settings: Settings;
  config: RulesConfig;
  sync: SyncResult;
  onSaveSettings: (next: Settings) => Promise<void>;
  /** 取得設定を保存して、ルールを取り直す */
  onSaveConfig: (next: RulesConfig) => Promise<void>;
  onRefetch: () => Promise<void>;
  /** 1つ前のルールに戻す */
  onRollback: () => Promise<void>;
  /** 保留にしていた最新のルールに戻す */
  onRestoreLatest: () => Promise<void>;
}

/** 区切り文字（読点・カンマ・改行）で分けた別名の一覧にする */
const splitAliases = (text: string): string[] => [
  ...new Set(text.split(/[、,\n]/).map((s) => s.trim()).filter((s) => s !== "")),
];

export function SettingsScreen(props: Props) {
  return (
    <div class="screen">
      <RulesSourceForm {...props} />
      {props.sync.rules && (
        <>
          <PointValues {...props} />
          <AnnualSettings {...props} />
          <MethodToggles {...props} />
          <StoreSettings {...props} />
          <ServiceSettings {...props} />
          <LocationSettings />
        </>
      )}
      <p class="hint">アプリの版：{__BUILD_ID__}</p>
    </div>
  );
}

function RulesSourceForm({ config, sync, onSaveConfig, onRefetch, onRollback, onRestoreLatest }: Props) {
  const [owner, setOwner] = useState(config.source?.owner ?? "");
  const [repo, setRepo] = useState(config.source?.repo ?? "");
  const [path, setPath] = useState(config.source?.path ?? "rules/rules.json");
  const [token, setToken] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const source: RulesSource = { owner: owner.trim(), repo: repo.trim(), path: path.trim() };
    const problems = checkSource(source);
    // トークン欄が空なら、保存済みのトークンをそのまま使う
    const next_token = token.trim() === "" ? config.token : token.trim();
    if (next_token === null) problems.push("アクセストークンを入力してください");
    else if (!isTokenFormatValid(next_token)) problems.push("アクセストークンの形式が正しくありません（前後の空白や改行を確認）");
    setErrors(problems);
    if (problems.length > 0) return;
    setBusy(true);
    try {
      await onSaveConfig({ source, token: next_token });
      setToken("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <details class="card" open={sync.rules === null}>
      <summary>ルールの取得</summary>
      <p class="hint">
        {sync.fetched_at ? `使用中のルール：${new Date(sync.fetched_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} 取得` : "ルールは未取得です。"}
      </p>
      <label class="field">
        所有者名
        <input class="input" type="text" autocomplete="off" autocapitalize="off" value={owner} onInput={(e) => setOwner(e.currentTarget.value)} />
      </label>
      <label class="field">
        リポジトリ名
        <input class="input" type="text" autocomplete="off" autocapitalize="off" value={repo} onInput={(e) => setRepo(e.currentTarget.value)} />
      </label>
      <label class="field">
        ファイルパス
        <input class="input" type="text" autocomplete="off" autocapitalize="off" value={path} onInput={(e) => setPath(e.currentTarget.value)} />
      </label>
      <label class="field">
        アクセストークン（{config.token ? "保存済み。変更するときだけ入力" : "未保存"}）
        <input class="input" type="password" autocomplete="off" value={token} onInput={(e) => setToken(e.currentTarget.value)} />
      </label>
      <p class="hint">
        トークンは、対象のリポジトリ1つだけ・Contents の読み取り専用で発行したものを使います。この端末の中にだけ保存し、バックアップには含めません。
      </p>
      {errors.map((e) => (
        <p key={e} class="error">
          {e}
        </p>
      ))}
      <button type="button" class="secondary" disabled={busy} onClick={() => void save()}>
        保存して取得
      </button>
      {config.source && config.token && (
        <button type="button" class="link" disabled={busy} onClick={() => void onRefetch()}>
          今すぐ再取得
        </button>
      )}
      {sync.can_rollback && (
        <button type="button" class="link" disabled={busy} onClick={() => void onRollback()}>
          1つ前のルールに戻す
        </button>
      )}
      {sync.on_hold && (
        <button type="button" class="link" disabled={busy} onClick={() => void onRestoreLatest()}>
          最新のルールに戻す
        </button>
      )}
    </details>
  );
}

function PointValues({ official, settings, onSaveSettings }: Props) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const save = async (point_id: string) => {
    const value = parseYenValue(drafts[point_id] ?? "");
    if (value === null || value > MAX_POINT_VALUE_MILLIYEN) {
      setError("評価額は 0〜1000 円の数値（小数第3位まで）で入力してください");
      return;
    }
    setError(null);
    await onSaveSettings({ ...settings, point_values_milliyen: { ...settings.point_values_milliyen, [point_id]: value } });
    setDrafts(({ [point_id]: _saved, ...rest }) => rest);
  };
  const reset = async (point_id: string) => {
    const { [point_id]: _removed, ...rest } = settings.point_values_milliyen;
    await onSaveSettings({ ...settings, point_values_milliyen: rest });
  };

  return (
    <details class="card">
      <summary>ポイントの評価額</summary>
      {official.points.map((p) => {
        const override = settings.point_values_milliyen[p.id];
        const current = override ?? p.value_milliyen;
        return (
          <div key={p.id} class="row">
            <label class="field">
              {p.name}（1 ポイント = 何円か。公式の既定値 {milliyenToInput(p.value_milliyen)} 円）
              <input
                class="input"
                type="text"
                inputMode="decimal"
                value={drafts[p.id] ?? milliyenToInput(current)}
                onInput={(e) => setDrafts({ ...drafts, [p.id]: e.currentTarget.value })}
              />
            </label>
            <button type="button" class="link" disabled={drafts[p.id] === undefined} onClick={() => void save(p.id)}>
              保存
            </button>
            {override !== undefined && (
              <button type="button" class="link" onClick={() => void reset(p.id)}>
                既定値に戻す
              </button>
            )}
          </div>
        );
      })}
      {error && <p class="error">{error}</p>}
    </details>
  );
}

function AnnualSettings({ merged, settings, onSaveSettings }: Props) {
  const [threshold, setThreshold] = useState(String(settings.annual_threshold_yen));
  const [error, setError] = useState<string | null>(null);
  const cards = merged.cards.filter((c) => c.annual_target);

  const saveThreshold = async () => {
    const parsed = parseAmount(threshold);
    if (!parsed.ok || parsed.amount_yen === null || parsed.amount_yen > MAX_THRESHOLD_YEN) {
      setError(`閾値は 0〜${MAX_THRESHOLD_YEN.toLocaleString("ja-JP")} 円の整数で入力してください`);
      return;
    }
    setError(null);
    await onSaveSettings({ ...settings, annual_threshold_yen: parsed.amount_yen });
  };
  const savePeriod = async (card_id: string, month: number, day: number) => {
    await onSaveSettings({ ...settings, annual_period_start: { ...settings.annual_period_start, [card_id]: { month, day } } });
  };

  return (
    <details class="card">
      <summary>年間目標</summary>
      <label class="field">
        優先する差額の上限（ペース遅れのとき、1位との差がこの額以内なら目標のあるカードを1位にする）[円]
        <input class="input" type="text" inputMode="numeric" value={threshold} onInput={(e) => setThreshold(e.currentTarget.value)} />
      </label>
      <button type="button" class="link" onClick={() => void saveThreshold()}>
        保存
      </button>
      {error && <p class="error">{error}</p>}
      {cards.map((card) => {
        const target = card.annual_target;
        if (!target) return null;
        return (
          <div key={card.id} class="row">
            <span class="field-label">{card.name}：集計の開始日</span>
            <select
              class="input select"
              aria-label={`${card.name}の集計開始月`}
              value={target.period_start_month}
              onChange={(e) => void savePeriod(card.id, Number(e.currentTarget.value), target.period_start_day)}
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {m} 月
                </option>
              ))}
            </select>
            <select
              class="input select"
              aria-label={`${card.name}の集計開始日`}
              value={target.period_start_day}
              onChange={(e) => void savePeriod(card.id, target.period_start_month, Number(e.currentTarget.value))}
            >
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {d} 日
                </option>
              ))}
            </select>
          </div>
        );
      })}
    </details>
  );
}

function MethodToggles({ merged, settings, onSaveSettings }: Props) {
  const toggle = async (method_id: string, enabled: boolean) => {
    const disabled = new Set(settings.disabled_method_ids);
    if (enabled) disabled.delete(method_id);
    else disabled.add(method_id);
    await onSaveSettings({ ...settings, disabled_method_ids: [...disabled] });
  };
  return (
    <details class="card">
      <summary>支払い手段（使うものにチェック）</summary>
      {merged.methods.map((m) => (
        <label key={m.id} class="check">
          <input
            type="checkbox"
            checked={!settings.disabled_method_ids.includes(m.id)}
            onChange={(e) => void toggle(m.id, e.currentTarget.checked)}
          />
          {m.label}
        </label>
      ))}
    </details>
  );
}

function StoreSettings({ official, merged, settings, onSaveSettings }: Props) {
  const [name, setName] = useState("");
  const [aliases, setAliases] = useState("");
  const [online, setOnline] = useState(false);
  const [selected_id, setSelectedId] = useState("");
  const [alias_draft, setAliasDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    const trimmed = name.trim();
    if (trimmed === "" || trimmed.length > 100) {
      setError("店名を入力してください（100 文字まで）");
      return;
    }
    setError(null);
    const id = newCustomStoreId(merged.stores.map((s) => s.id));
    await onSaveSettings({
      ...settings,
      custom_stores: [...settings.custom_stores, { id, name: trimmed, aliases: splitAliases(aliases), channel: online ? "online" : "in_store" }],
    });
    setName("");
    setAliases("");
    setOnline(false);
    setSelectedId(id);
  };

  const store = merged.stores.find((s) => s.id === selected_id);
  const is_custom = settings.custom_stores.some((s) => s.id === selected_id);
  // この店舗を条件にしている還元ルール（店舗単位の例外にできるもの）
  const group_ids = new Set(official.store_groups.filter((g) => g.store_ids.includes(selected_id)).map((g) => g.id));
  const targeting: Array<{ rule: RewardRule; owner: string }> = [
    ...official.cards.flatMap((c) => c.rewards.map((rule) => ({ rule, owner: c.name }))),
    ...official.methods.flatMap((m) => (m.rewards ?? []).map((rule) => ({ rule, owner: m.label }))),
  ].filter(
    ({ rule }) =>
      // 日付で切り替わる後継のルールは一覧に出さない（元のルールの例外が引き継がれる）
      !isSuccessorRuleId(rule.id) &&
      ((rule.applies.store_ids ?? []).includes(selected_id) || (rule.applies.store_group_ids ?? []).some((id) => group_ids.has(id))),
  );

  const saveAliases = async () => {
    if (alias_draft === null) return;
    const list = splitAliases(alias_draft);
    if (is_custom) {
      await onSaveSettings({
        ...settings,
        custom_stores: settings.custom_stores.map((s) => (s.id === selected_id ? { ...s, aliases: list } : s)),
      });
    } else {
      const { [selected_id]: _old, ...rest } = settings.extra_aliases;
      await onSaveSettings({ ...settings, extra_aliases: list.length > 0 ? { ...rest, [selected_id]: list } : rest });
    }
    setAliasDraft(null);
  };
  const toggleException = async (rule_id: string, excluded: boolean) => {
    const others = settings.store_exceptions.filter((e) => !(e.store_id === selected_id && e.rule_id === rule_id));
    await onSaveSettings({
      ...settings,
      store_exceptions: excluded ? [...others, { store_id: selected_id, rule_id }] : others,
    });
  };
  const toggleUnusable = async (method_id: string, unusable: boolean) => {
    const current = new Set(settings.unusable_methods[selected_id] ?? []);
    if (unusable) current.add(method_id);
    else current.delete(method_id);
    const { [selected_id]: _old, ...rest } = settings.unusable_methods;
    await onSaveSettings({ ...settings, unusable_methods: current.size > 0 ? { ...rest, [selected_id]: [...current] } : rest });
  };
  const removeCustom = async () => {
    if (!confirm(`「${store?.name ?? ""}」を削除しますか？`)) return;
    const { [selected_id]: _a, ...unusable_methods } = settings.unusable_methods;
    await onSaveSettings({
      ...settings,
      custom_stores: settings.custom_stores.filter((s) => s.id !== selected_id),
      favorite_store_ids: settings.favorite_store_ids.filter((id) => id !== selected_id),
      unusable_methods,
    });
    setSelectedId("");
  };

  const own_aliases = is_custom
    ? (settings.custom_stores.find((s) => s.id === selected_id)?.aliases ?? [])
    : (settings.extra_aliases[selected_id] ?? []);
  const official_store = official.stores.find((s) => s.id === selected_id);

  return (
    <details class="card">
      <summary>店舗</summary>
      <h2>店舗を追加</h2>
      <label class="field">
        店名
        <input class="input" type="text" value={name} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <label class="field">
        別名（「、」で区切る。任意）
        <input class="input" type="text" value={aliases} onInput={(e) => setAliases(e.currentTarget.value)} />
      </label>
      <label class="check">
        <input type="checkbox" checked={online} onChange={(e) => setOnline(e.currentTarget.checked)} />
        通販の店舗
      </label>
      {error && <p class="error">{error}</p>}
      <button type="button" class="secondary" onClick={() => void add()}>
        追加
      </button>

      <h2 class="spaced">
        <label for="store-edit">店舗ごとの設定</label>
      </h2>
      <select
        id="store-edit"
        class="input select"
        value={selected_id}
        onChange={(e) => {
          setSelectedId(e.currentTarget.value);
          setAliasDraft(null);
        }}
      >
        <option value="">店舗を選ぶ</option>
        {merged.stores.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
            {settings.custom_stores.some((c) => c.id === s.id) ? "（追加した店舗）" : ""}
          </option>
        ))}
      </select>

      {store && (
        <>
          <label class="field">
            {is_custom ? "別名" : "追加する別名"}（「、」で区切る）
            {official_store && official_store.aliases.length > 0 && ` ／公式の別名：${official_store.aliases.join("、")}`}
            <input
              class="input"
              type="text"
              value={alias_draft ?? own_aliases.join("、")}
              onInput={(e) => setAliasDraft(e.currentTarget.value)}
            />
          </label>
          <button type="button" class="link" disabled={alias_draft === null} onClick={() => void saveAliases()}>
            別名を保存
          </button>

          {targeting.length > 0 && <h2>この店では適用しない還元（商業施設内の店舗など）</h2>}
          {targeting.map(({ rule, owner }) => (
            <label key={rule.id} class="check">
              <input
                type="checkbox"
                checked={settings.store_exceptions.some((e) => e.store_id === selected_id && e.rule_id === rule.id)}
                onChange={(e) => void toggleException(rule.id, e.currentTarget.checked)}
              />
              {owner}：{rule.label}
            </label>
          ))}

          <h2>この店で使えない支払い手段</h2>
          {merged.methods.map((m) => (
            <label key={m.id} class="check">
              <input
                type="checkbox"
                checked={(settings.unusable_methods[selected_id] ?? []).includes(m.id)}
                onChange={(e) => void toggleUnusable(m.id, e.currentTarget.checked)}
              />
              {m.label}
            </label>
          ))}

          {is_custom && (
            <button type="button" class="link danger" onClick={() => void removeCustom()}>
              この店舗を削除
            </button>
          )}
        </>
      )}
    </details>
  );
}

function ServiceSettings({ official, merged, settings, onSaveSettings }: Props) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [store_ids, setStoreIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const catalog = official.services ?? [];

  const toggle = async (service_id: string, enabled: boolean) => {
    const current = new Set(settings.enabled_service_ids);
    if (enabled) current.add(service_id);
    else current.delete(service_id);
    await onSaveSettings({ ...settings, enabled_service_ids: [...current] });
  };
  const add = async () => {
    const trimmed = name.trim();
    const link = url.trim();
    if (trimmed === "" || trimmed.length > 100) {
      setError("サービス名を入力してください（100 文字まで）");
      return;
    }
    if (link !== "" && (!isSafeHttpsUrl(link) || link.length > 500)) {
      setError("リンクは https:// で始まる URL を入力してください");
      return;
    }
    setError(null);
    const id = newCustomServiceId(settings.custom_services.map((s) => s.id));
    await onSaveSettings({
      ...settings,
      custom_services: [...settings.custom_services, { id, name: trimmed, store_ids, url: link === "" ? null : link }],
    });
    setName("");
    setUrl("");
    setStoreIds([]);
  };
  const remove = async (service_id: string, service_name: string) => {
    if (!confirm(`「${service_name}」を削除しますか？`)) return;
    await onSaveSettings({ ...settings, custom_services: settings.custom_services.filter((s) => s.id !== service_id) });
  };
  const storeName = (id: string): string => merged.stores.find((s) => s.id === id)?.name ?? id;

  return (
    <details class="card">
      <summary>利用中のサービス（クーポン・優待の確認先）</summary>
      <p class="hint">チェックしたサービスだけ、店舗を選んだときに「クーポンがあるか確認」のリンクを出します。</p>
      {catalog.length === 0 && <p class="hint">ルールにサービスの一覧がありません。</p>}
      {catalog.map((s) => (
        <label key={s.id} class="check">
          <input
            type="checkbox"
            checked={settings.enabled_service_ids.includes(s.id)}
            onChange={(e) => void toggle(s.id, e.currentTarget.checked)}
          />
          {s.name}
          {s.store_ids ? `（${s.store_ids.map(storeName).join("、")}）` : "（すべての店舗）"}
        </label>
      ))}

      {settings.custom_services.length > 0 && <h2 class="spaced">自分で追加したサービス</h2>}
      {settings.custom_services.map((s) => (
        <div key={s.id} class="row">
          <span>
            {s.name}
            {s.store_ids.length > 0 ? `（${s.store_ids.map(storeName).join("、")}）` : "（すべての店舗）"}
          </span>
          <button type="button" class="link danger" onClick={() => void remove(s.id, s.name)}>
            削除
          </button>
        </div>
      ))}

      <h2 class="spaced">サービスを追加</h2>
      <label class="field">
        サービス名
        <input class="input" type="text" value={name} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <label class="field">
        開くページの URL（任意。https:// で始まるもの）
        <input class="input" type="url" autocapitalize="off" value={url} onInput={(e) => setUrl(e.currentTarget.value)} />
      </label>
      <details class="field-group">
        <summary>対象店舗：{store_ids.length === 0 ? "すべての店舗" : `${store_ids.length} 店舗を選択中`}</summary>
        {merged.stores.map((s) => (
          <label key={s.id} class="check">
            <input
              type="checkbox"
              checked={store_ids.includes(s.id)}
              onChange={(e) => setStoreIds(e.currentTarget.checked ? [...store_ids, s.id] : store_ids.filter((id) => id !== s.id))}
            />
            {s.name}
          </label>
        ))}
      </details>
      {error && <p class="error">{error}</p>}
      <button type="button" class="secondary" onClick={() => void add()}>
        追加
      </button>
    </details>
  );
}
function LocationSettings() {
  const [cells, setCells] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    void loadNearbyCache().then((c) => setCells(Object.keys(c.cells).length));
  }, []);
  const clear = async () => {
    await clearNearbyCache();
    setCells(0);
    setMessage("位置の検索履歴を消しました。");
  };
  return (
    <details class="card">
      <summary>位置情報</summary>
      <p class="hint">
        位置は、店名で検索したときと「現在地から探す」を押したときだけ取得します。近くの店の検索（OpenStreetMap の
        Overpass API）には、約 100m 単位に丸めた座標だけを送ります。結果は場所ごとに最大 30 日、この端末に保存し、バックアップには含めません。
      </p>
      <p class="hint">保存している場所：{cells === null ? "…" : `${cells} か所`}</p>
      <button type="button" class="link danger" disabled={cells === 0} onClick={() => void clear()}>
        位置の検索履歴を消す
      </button>
      {message && <p class="hint">{message}</p>}
    </details>
  );
}
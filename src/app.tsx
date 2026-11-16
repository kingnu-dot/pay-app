// 画面の最上位：端末内のデータを読み込み、ルールを同期して各画面に渡す

import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { annualPeriod } from "./engine/annual";
import { toJstDate } from "./engine/dates";
import { sumAnnualSpent } from "./engine/spend";
import { fetchRules } from "./rules/fetch";
import { syncRules, type SyncResult } from "./rules/sync";
import { mergeRules, type Settings } from "./settings/settings";
import {
  addSpend,
  idbRulesCache,
  listSpend,
  loadRulesConfig,
  loadSettings,
  saveSettings,
  type RulesConfig,
  type SpendEntry,
} from "./storage/db";
import { problemText } from "./ui/explain";
import { Home, type PaidRecord } from "./ui/Home";

interface AppData {
  config: RulesConfig;
  sync: SyncResult;
  settings: Settings;
  spend: SpendEntry[];
}

async function loadAll(): Promise<AppData> {
  const config = await loadRulesConfig();
  const { source, token } = config;
  const fetcher =
    source !== null && token !== null
      ? (etag: string | null) => fetchRules({ source, token, etag, fetch_fn: (url, init) => fetch(url, init) })
      : null;
  const [sync, settings, spend] = await Promise.all([
    syncRules({ cache: idbRulesCache, fetcher, now: () => new Date() }),
    loadSettings(),
    listSpend(),
  ]);
  return { config, sync, settings, spend };
}

export function App() {
  const [data, setData] = useState<AppData | null>(null);
  const [load_error, setLoadError] = useState<string | null>(null);
  const [today, setToday] = useState(() => toJstDate(new Date()));

  const reload = useCallback(async () => {
    try {
      setData(await loadAll());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void reload();
    // アプリに戻ってきたときに日付を更新する（日をまたいで開きっぱなしの場合に備える）
    const onVisible = () => {
      if (document.visibilityState === "visible") setToday(toJstDate(new Date()));
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [reload]);

  const merged = useMemo(
    () => (data?.sync.rules ? mergeRules(data.sync.rules, data.settings) : null),
    [data?.sync.rules, data?.settings],
  );

  const annual_spent_yen = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const card of merged?.rules.cards ?? []) {
      const target = card.annual_target;
      if (!target) continue;
      const period = annualPeriod(today, target.period_start_month, target.period_start_day);
      totals[card.id] = sumAnnualSpent(data?.spend ?? [], card.id, period);
    }
    return totals;
  }, [merged, data?.spend, today]);

  if (load_error !== null) {
    return (
      <main>
        <p class="banner banner-error">端末内のデータを読み込めませんでした：{load_error}</p>
      </main>
    );
  }
  if (data === null) {
    return (
      <main>
        <p class="hint">読み込み中…</p>
      </main>
    );
  }

  const updateSettings = async (next: Settings) => {
    await saveSettings(next);
    setData({ ...data, settings: next });
  };
  const toggleFavorite = (store_id: string) => {
    const current = data.settings.favorite_store_ids;
    const favorite_store_ids = current.includes(store_id) ? current.filter((id) => id !== store_id) : [...current, store_id];
    void updateSettings({ ...data.settings, favorite_store_ids });
  };
  const recordPaid = async (record: PaidRecord) => {
    await addSpend({
      date: today,
      amount_yen: record.amount_yen,
      kind: "payment",
      method_id: record.method_id,
      annual_card_id: record.annual_card_id,
      note: `${record.store_name}／${record.method_label}`,
      created_at: new Date().toISOString(),
    });
    setData({ ...data, spend: await listSpend() });
  };

  const problem = problemText(data.sync.problem, merged !== null);

  return (
    <main>
      <header class="app-header">
        <h1>支払い手段おすすめ</h1>
      </header>
      {problem && <p class="banner banner-warn">{problem}</p>}
      {data.sync.updated && <p class="banner banner-ok">ルールを最新版に更新しました。</p>}
      {merged && merged.errors.length > 0 && (
        <p class="banner banner-warn">
          個人設定を反映できなかったため、公式ルールだけで判定しています（{merged.errors.slice(0, 2).join(" / ")}）
        </p>
      )}
      {merged ? (
        <Home
          rules={merged.rules}
          settings={data.settings}
          today={today}
          annual_spent_yen={annual_spent_yen}
          onToggleFavorite={toggleFavorite}
          onPaid={recordPaid}
        />
      ) : (
        <section class="card">
          <h2>はじめに</h2>
          <p>ルールがまだありません。</p>
        </section>
      )}
      {import.meta.env.DEV && <DevTools onLoaded={reload} />}
    </main>
  );
}

/** 開発時だけ表示する操作。本番のビルドには含まれない */
function DevTools(props: { onLoaded: () => Promise<void> }) {
  const loadSample = async () => {
    const sample = (await import("../tests/fixtures/sample-rules.json")).default;
    const state = await idbRulesCache.load();
    await idbRulesCache.save({
      current: { rules: sample, etag: null, fetched_at: new Date().toISOString() },
      previous: state.previous,
    });
    await props.onLoaded();
  };
  return (
    <section class="card dev">
      <h2>開発用</h2>
      <button type="button" class="choice" onClick={() => void loadSample()}>
        架空のサンプルルールを読み込む
      </button>
    </section>
  );
}

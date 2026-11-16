// 画面の最上位：端末内のデータを読み込み、ルールを同期して各画面に渡す

import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { couponsForStore, enabledServices, expiringSoon, type Coupon } from "./coupons/coupons";
import { annualPeriod } from "./engine/annual";
import { toJstDate } from "./engine/dates";
import { adjustmentFor, sumAnnualSpent } from "./engine/spend";
import { fetchRules } from "./rules/fetch";
import { syncRules, type SyncResult } from "./rules/sync";
import type { Rules } from "./rules/types";
import { mergeRules, type Settings } from "./settings/settings";
import {
  addSpend,
  deleteSpend,
  idbRulesCache,
  listSpend,
  loadCoupons,
  loadLastBackupDate,
  loadRulesConfig,
  loadSettings,
  replaceUserData,
  saveCoupons,
  saveLastBackupDate,
  saveRulesConfig,
  saveSettings,
  type RulesConfig,
  type SpendEntry,
} from "./storage/db";
import { isBackupDue, type BackupFile } from "./backup/backup";
import { Annual } from "./ui/Annual";
import { Backup } from "./ui/Backup";
import { CouponsScreen } from "./ui/CouponsScreen";
import { problemText } from "./ui/explain";
import { Home, type PaidRecord } from "./ui/Home";
import { SettingsScreen } from "./ui/SettingsScreen";

interface AppData {
  config: RulesConfig;
  sync: SyncResult;
  settings: Settings;
  spend: SpendEntry[];
  coupons: Coupon[];
  last_backup_date: string | null;
}

async function loadAll(): Promise<AppData> {
  const config = await loadRulesConfig();
  const { source, token } = config;
  const fetcher =
    source !== null && token !== null
      ? (etag: string | null) => fetchRules({ source, token, etag, fetch_fn: (url, init) => fetch(url, init) })
      : null;
  const [sync, settings, spend, last_backup_date, coupons] = await Promise.all([
    syncRules({ cache: idbRulesCache, fetcher, now: () => new Date() }),
    loadSettings(),
    listSpend(),
    loadLastBackupDate(),
    loadCoupons(),
  ]);
  return { config, sync, settings, spend, coupons, last_backup_date };
}

/** ルールが無いときに設定画面へ渡す、空のルール */
const EMPTY_RULES: Rules = {
  schema_version: 1,
  updated_at: "1970-01-01",
  points: [],
  cards: [],
  methods: [],
  stores: [],
  store_groups: [],
  redemptions: [],
};

/** 新しい版の Service Worker に切り替わったことを知らせるイベント名（main.tsx から送る） */
export const UPDATE_READY_EVENT = "app-update-ready";

type Tab = "home" | "coupons" | "annual" | "settings";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "home", label: "ホーム" },
  { id: "coupons", label: "クーポン" },
  { id: "annual", label: "年間目標" },
  { id: "settings", label: "設定" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("home");
  const [data, setData] = useState<AppData | null>(null);
  const [load_error, setLoadError] = useState<string | null>(null);
  const [today, setToday] = useState(() => toJstDate(new Date()));
  const [update_ready, setUpdateReady] = useState(false);

  useEffect(() => {
    const onUpdate = () => setUpdateReady(true);
    window.addEventListener(UPDATE_READY_EVENT, onUpdate);
    return () => window.removeEventListener(UPDATE_READY_EVENT, onUpdate);
  }, []);

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

  const services = useMemo(
    () => (data ? enabledServices(data.sync.rules?.services ?? [], data.settings) : []),
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

  const setAnnualTotal = async (card_id: string, entered_total_yen: number) => {
    const diff_yen = adjustmentFor(annual_spent_yen[card_id] ?? 0, entered_total_yen);
    if (diff_yen !== 0) {
      await addSpend({
        date: today,
        amount_yen: diff_yen,
        kind: "adjustment",
        method_id: null,
        annual_card_id: card_id,
        note: "累計の補正",
        created_at: new Date().toISOString(),
      });
    }
    setData({ ...data, spend: await listSpend() });
  };
  const removeEntry = async (id: number) => {
    await deleteSpend(id);
    setData({ ...data, spend: await listSpend() });
  };

  const markExported = async () => {
    await saveLastBackupDate(today);
    setData({ ...data, last_backup_date: today });
  };
  const restore = async (backup: BackupFile) => {
    await replaceUserData(backup.settings, backup.spend, backup.coupons);
    await reload();
  };
  const backup_due = isBackupDue(data.last_backup_date, today, data.spend.length);

  const updateCoupons = async (next: Coupon[]) => {
    await saveCoupons(next);
    setData({ ...data, coupons: next });
  };
  const markCouponUsed = (coupon_id: string) =>
    void updateCoupons(data.coupons.map((c) => (c.id === coupon_id ? { ...c, used: true } : c)));

  const saveConfig = async (next: RulesConfig) => {
    await saveRulesConfig(next);
    await reload();
  };

  const problem = problemText(data.sync.problem, merged !== null);

  return (
    <main>
      <header class="app-header">
        <h1>支払い手段おすすめ</h1>
      </header>
      {update_ready && (
        <p class="banner banner-info">
          アプリの新しい版があります。
          <button type="button" class="link" onClick={() => location.reload()}>
            再読み込みして切り替える
          </button>
        </p>
      )}
      {problem && <p class="banner banner-warn">{problem}</p>}
      {data.sync.updated && <p class="banner banner-ok">ルールを最新版に更新しました。</p>}
      {merged && merged.errors.length > 0 && (
        <p class="banner banner-warn">
          個人設定を反映できなかったため、公式ルールだけで判定しています（{merged.errors.slice(0, 2).join(" / ")}）
        </p>
      )}
      {merged && tab === "annual" && (
        <Annual
          rules={merged.rules}
          today={today}
          spend={data.spend}
          annual_spent_yen={annual_spent_yen}
          onSetTotal={setAnnualTotal}
          onDeleteEntry={removeEntry}
        />
      )}
      {tab === "home" && backup_due && (
        <p class="banner banner-warn">
          バックアップを取りましょう（前回：{data.last_backup_date ?? "まだありません"}）。
          <button type="button" class="link" onClick={() => setTab("settings")}>
            設定のバックアップへ
          </button>
        </p>
      )}
      {tab === "coupons" && (
        <CouponsScreen
          coupons={data.coupons}
          stores={merged?.rules.stores ?? []}
          services={services}
          today={today}
          onSave={updateCoupons}
        />
      )}
      {tab === "settings" && (
        <SettingsScreen
          official={data.sync.rules ?? EMPTY_RULES}
          merged={merged?.rules ?? EMPTY_RULES}
          settings={data.settings}
          config={data.config}
          sync={data.sync}
          onSaveSettings={updateSettings}
          onSaveConfig={saveConfig}
          onRefetch={reload}
        />
      )}
      {tab === "settings" && (
        <Backup
          settings={data.settings}
          spend={data.spend}
          coupons={data.coupons}
          today={today}
          last_backup_date={data.last_backup_date}
          onExported={markExported}
          onRestore={restore}
        />
      )}
      {tab !== "home" ? null : merged ? (
        <Home
          rules={merged.rules}
          settings={data.settings}
          today={today}
          annual_spent_yen={annual_spent_yen}
          expiring_coupons={expiringSoon(data.coupons, today)}
          couponsFor={(store_id) => couponsForStore(data.coupons, store_id, today)}
          services={services}
          onCouponUsed={markCouponUsed}
          onOpenCoupons={() => setTab("coupons")}
          onToggleFavorite={toggleFavorite}
          onPaid={recordPaid}
        />
      ) : (
        <section class="card">
          <h2>はじめに</h2>
          <p>ルールがまだありません。「設定」でルールの取得先とアクセストークンを入力してください。</p>
        </section>
      )}
      {import.meta.env.DEV && <DevTools onLoaded={reload} />}
      <nav class="tabs" aria-label="画面の切り替え">
        {TABS.map((t) => (
          <button key={t.id} type="button" class="tab" aria-current={tab === t.id ? "page" : undefined} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
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

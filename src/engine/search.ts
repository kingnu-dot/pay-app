// 店舗の検索（名前と別名の部分一致）

import type { Store } from "../rules/types";

/** 比較用に表記をそろえる：全角英数→半角、大文字→小文字、カタカナ→ひらがな、空白を除く */
export function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/\s+/g, "");
}

/**
 * 店舗を検索する。
 * - 検索語が空なら、お気に入りを先頭にして全件を返す
 * - 検索語があれば、名前か別名に含むものを返す（前方一致 → お気に入り → ルールの記載順）
 */
export function searchStores(stores: readonly Store[], query: string, favorite_ids: readonly string[]): Store[] {
  const favorites = new Set(favorite_ids);
  const q = normalizeText(query);
  const scored: Array<{ store: Store; prefix: boolean; index: number }> = [];
  stores.forEach((store, index) => {
    const names = [store.name, ...store.aliases].map(normalizeText);
    if (q !== "" && !names.some((n) => n.includes(q))) return;
    scored.push({ store, prefix: q !== "" && names.some((n) => n.startsWith(q)), index });
  });
  scored.sort(
    (a, b) =>
      Number(b.prefix) - Number(a.prefix) ||
      Number(favorites.has(b.store.id)) - Number(favorites.has(a.store.id)) ||
      a.index - b.index,
  );
  return scored.map((s) => s.store);
}

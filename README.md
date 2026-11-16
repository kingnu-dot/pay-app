# pay-app

支払い手段を比較して、最もお得なものを表示する個人用の PWA（アプリ本体）。

- サーバなし・完全無料。画面と判定エンジンだけをこのリポジトリに置き、GitHub Pages で配信する。
- カード・店舗・ポイントの具体的なルールは、このリポジトリには含めない。別の非公開リポジトリに置いたルール JSON を、アプリが起動時に取得する。
- 個人データ（利用額、個人設定）は端末内（IndexedDB）にだけ保存する。

## 注意事項

- このアプリは GitHub Pages のプロジェクトサイト（`https://<ユーザー名>.github.io/pay-app`）として配信する。
- ブラウザの保存領域（IndexedDB など）はホスト名単位で共有されるため、**同じ GitHub アカウントで他の GitHub Pages サイトを作らない**こと。
  - 他の Pages サイトを作ると、そのサイトのスクリプトから、このアプリが端末に保存したアクセストークンと個人データを読めてしまう。
  - 他のサイトを公開したくなった場合は、別の GitHub アカウントを使うか、このアプリを専用アカウントへ移す。

## 使い方

1. ルール JSON を置いた非公開リポジトリを用意する。
2. そのリポジトリ1つだけ・Contents の読み取り専用の fine-grained personal access token を発行する。
3. アプリの「設定」→「ルールの取得」に、所有者名・リポジトリ名・ファイルパス・トークンを入力する。
4. 「ホーム」で店舗と金額を選ぶと、おすすめの支払い手段が表示される。

トークンは端末内にだけ保存され、バックアップのファイルには含まれない。

## 画面

| 画面 | 内容 |
|---|---|
| ホーム | 店舗の検索・お気に入り、金額入力、おすすめ（内訳・理由・注意事項）、2位以下、「これで払った」の記録、その店で使えるクーポン・優待 |
| クーポン | 手動で登録したクーポン・優待の一覧、登録・編集、使用済み、Google カレンダーへの追加 |
| 年間目標 | 累計・残額・残り日数・1日あたり必要額・達成ペース、累計の補正入力、利用記録の一覧 |
| 設定 | ルールの取得、ポイントの評価額、年間目標の閾値と集計開始日、支払い手段の有効/無効、店舗の追加と店舗ごとの設定、利用中のサービス、バックアップ（書き出し・復元） |

クーポンの中身を外部から取得することはしない。登録済みのサービスについて「クーポンがあるか確認」とアプリを開くリンク、店名で検索するリンクを出すだけ。期限が 7 日以内のクーポンはホームの上部に表示する。

## ルール JSON

- 構造は [schema/rules.schema.json](schema/rules.schema.json) で定義している。
- 架空のカード・店舗を使った例が [tests/fixtures/sample-rules.json](tests/fixtures/sample-rules.json) にある。

還元ルールの例（架空のカード）：200 円ごとに 1 ポイント、1回の利用ごとに四捨五入、提携店ではその後に 3 倍。

```json
{
  "id": "card_b_partner",
  "label": "提携店 3 倍",
  "point_id": "point_y",
  "unit_yen": 200,
  "points_per_unit": 1,
  "scope": "per_txn",
  "rounding": "round",
  "multiplier": 3,
  "stacking": "replace_base",
  "applies": { "pay_types": ["card_insert"], "store_group_ids": ["group_partner"] },
  "meta": {
    "source_url": "https://example.com/card-b/partner",
    "last_verified": "2026-01-10",
    "valid_from": null,
    "valid_to": null,
    "cap": null
  }
}
```

計算の順序は「金額 ÷ `unit_yen` を端数処理 → `points_per_unit` を掛ける → `multiplier` を掛ける」。
この例では 300 円が「四捨五入で 2 → 3 倍で 6 ポイント」になる。

## 開発

```
npm install
npm run dev      # 開発サーバ（http://localhost:5173/pay-app/）
npm test         # 単体テスト
npm run lint     # 型チェックと lint
npm run build    # 本番ビルド（dist/）
npm run preview  # 本番ビルドの確認（http://localhost:4173/pay-app/）
```

- 開発サーバでは、画面下の「開発用」から架空のサンプルルールを読み込める（本番ビルドには含まれない）。
- 金額は整数（円）で扱い、円換算額は 1/1000 円の整数で計算する。日付は Asia/Tokyo 基準。
- Service Worker とアイコンは本番ビルドでだけ有効になる。アイコンは `node scripts/make-icons.mjs` で作り直せる。

## 配信

`.github/workflows/deploy.yml` を手動実行すると、テスト・lint・ビルドのあと GitHub Pages に配信する。
事前に、リポジトリの Settings → Pages で Source を「GitHub Actions」にしておく。

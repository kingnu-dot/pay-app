// ルール JSON の型。schema/rules.schema.json と対応させる（変更時は両方を直す）

/** 店頭・通販での払い方 */
export type PurchasePayType =
  | "google_pay_touch"
  | "card_insert"
  | "card_touch"
  | "id_quicpay"
  | "qr_pay"
  | "transit_ic"
  | "point_use"
  | "online";

/** チャージの種類 */
export type ChargePayType = "charge_transit_ic" | "charge_qr_pay" | "charge_emoney";

export type PayType = PurchasePayType | ChargePayType;

/**
 * 上限。amount は unit の単位での整数。
 * 還元ルールでは、unit が point なら付与されるポイントの上限、yen なら還元の対象になる金額の上限
 */
export interface Cap {
  amount: number;
  unit: "point" | "yen";
  period: "txn" | "day" | "month" | "year";
}

/** ルールの出典と有効期間（日付は YYYY-MM-DD、Asia/Tokyo の暦日） */
export interface Meta {
  source_url: string;
  last_verified: string;
  valid_from: string | null;
  valid_to: string | null;
  cap: Cap | null;
  confidence?: "verified" | "unverified";
  note?: string;
}

export interface Point {
  id: string;
  name: string;
  /** 1 ポイントの評価額 [1/1000 円] */
  value_milliyen: number;
}

/**
 * 適用条件。指定した項目をすべて満たすときに適用する。
 * ただし店舗の条件は、store_group_ids と store_ids のどちらかに該当すればよい
 */
export interface Applies {
  pay_types?: PayType[];
  store_group_ids?: string[];
  store_ids?: string[];
  exclude_store_ids?: string[];
  days_of_month?: number[];
}

/**
 * 還元ルール。計算順序：
 * (1) 金額 ÷ unit_yen を rounding で整数にする (2) points_per_unit を掛ける (3) multiplier を掛ける。
 * 端数処理は必ず (1) で行い、掛け算はその後に行う
 */
export interface RewardRule {
  id: string;
  label: string;
  point_id: string;
  /** 計算単位 [円] */
  unit_yen: number;
  /** 計算単位あたりの付与量 [ポイント] */
  points_per_unit: number;
  scope: "per_txn" | "monthly";
  rounding: "floor" | "round";
  /** 端数処理の後に掛ける倍率（省略時 1） */
  multiplier?: number;
  stacking: "base" | "add" | "replace_base";
  applies: Applies;
  meta: Meta;
}

export interface AnnualTarget {
  target_yen: number;
  period_start_month: number;
  period_start_day: number;
  meta: Meta;
}

export interface Card {
  id: string;
  name: string;
  rewards: RewardRule[];
  annual_target?: AnnualTarget;
}

export interface MethodWarning {
  amount_gt_yen?: number;
  text: string;
}

export interface Funding {
  card_id: string | null;
  pay_type: ChargePayType;
  note?: string;
}

/** 支払い手段（カード × 払い方） */
export interface Method {
  id: string;
  label: string;
  pay_type: PurchasePayType;
  card_id: string | null;
  funding?: Funding;
  /** この手段を使う店舗の限定。指定した店舗グループのどれかに属する店舗でだけ候補にする */
  only_store_group_ids?: string[];
  rewards?: RewardRule[];
  earns_points: boolean;
  counts_toward_annual: boolean;
  warnings?: MethodWarning[];
}

export interface Loyalty {
  label: string;
  note?: string;
}

export interface Store {
  id: string;
  name: string;
  aliases: string[];
  /** in_store：店頭（省略時） / online：通販 */
  channel?: "in_store" | "online";
  loyalty?: Loyalty[];
  unusable_pay_types?: PurchasePayType[];
  unusable_method_ids?: string[];
  notes?: string[];
}

export interface StoreGroup {
  id: string;
  name: string;
  store_ids: string[];
  meta: Meta;
}

/** ポイント利用の案内 */
export interface Redemption {
  id: string;
  point_id: string;
  store_ids: string[];
  days_of_month?: number[];
  /** この条件で使うときの 1 ポイントの価値 [1/1000 円] */
  value_milliyen: number;
  text: string;
  meta: Meta;
}

export interface Rules {
  schema_version: 1;
  updated_at: string;
  points: Point[];
  cards: Card[];
  methods: Method[];
  stores: Store[];
  store_groups: StoreGroup[];
  redemptions: Redemption[];
}

/**
 * TypeScript interfaces for the Facebook (Meta) Marketing API data model.
 *
 * Based on the Meta Marketing API Insights endpoint:
 * https://developers.facebook.com/docs/marketing-api/insights
 *
 * We use Field Expansion to fetch ad object properties (like effective_status)
 * together with insights data in a single API call:
 * https://developers.facebook.com/docs/graph-api/using-graph-api/#field-expansion
 */

// ─── Credentials & Configuration ─────────────────────────────────────────────

export interface Credentials {
  /** Long-lived access token for the Meta Marketing API */
  accessToken: string;
}

export interface FetchParams {
  /** The date to fetch data for, in YYYY-MM-DD format */
  date: string;
  /** The ad account ID (numeric, without the "act_" prefix) */
  accountId: string;
  /** API credentials */
  credentials: Credentials;
}

// ─── Facebook API Raw Response Types ─────────────────────────────────────────

/** A single action object from the Facebook API (e.g., conversions, purchases) */
export interface FacebookAction {
  action_type: string;
  value: string;
}

/** A single action value (e.g., purchase ROAS) */
export interface FacebookActionValue {
  action_type: string;
  value: string;
}

/** Raw insight row returned inside the field-expansion `insights` block */
export interface FacebookInsightRow {
  account_id: string;
  account_currency: string;
  campaign_id: string;
  campaign_name: string;
  adset_id: string;
  adset_name: string;
  ad_id: string;
  ad_name: string;
  objective: string;
  impressions: string;
  clicks: string;
  spend: string;
  actions?: FacebookAction[];
  action_values?: FacebookActionValue[];
  purchase_roas?: FacebookActionValue[];
  date_start: string;
  date_stop: string;
  hourly_stats_aggregated_by_advertiser_time_zone: string;
}

/** Facebook API paging cursors */
export interface FacebookPaging {
  cursors: {
    before: string;
    after: string;
  };
  next?: string;
}

/** The nested insights object inside each ad (field expansion response) */
export interface FacebookInsightsBlock {
  data: FacebookInsightRow[];
  paging?: FacebookPaging;
}

/**
 * A single ad object returned by GET /act_{id}/ads with field expansion.
 * Contains ad-level properties (id, effective_status) and a nested `insights` block.
 */
export interface FacebookAdObject {
  id: string;
  effective_status: string;
  insights?: FacebookInsightsBlock;
}

/** Response envelope from GET /act_{id}/ads */
export interface FacebookAdsResponse {
  data: FacebookAdObject[];
  paging?: FacebookPaging;
}

// ─── Normalized Output Types ─────────────────────────────────────────────────

/** A single conversion/action in the normalized output */
export interface ActionEntry {
  type: string;
  count: number;
}

/** A normalized, clean ad-level hourly record for the output JSON */
export interface AdHourlyRecord {
  // Metadata
  account_id: string;
  date: string;
  hour: string;
  campaign_id: string;
  campaign_name: string;
  adset_id: string;
  adset_name: string;
  ad_id: string;
  ad_name: string;
  currency: string;
  /** Ad effective status (ACTIVE, PAUSED, ARCHIVED, etc.) */
  status: string;
  /** Campaign objective (e.g., OUTCOME_SALES, OUTCOME_TRAFFIC) */
  objective: string;

  // Metrics
  impressions: number;
  clicks: number;
  spend: number;
  purchase_roas: number | null;
  purchase_value: number | null;
  actions: ActionEntry[];
}

/** Aggregate summary statistics for the output */
export interface OutputSummary {
  total_impressions: number;
  total_clicks: number;
  total_spend: number;
  unique_ads: number;
  unique_campaigns: number;
  unique_adsets: number;
}

/** The full output file schema */
export interface OutputFile {
  metadata: {
    account_id: string;
    date: string;
    platform: string;
    fetched_at: string;
    total_records: number;
    /** Aggregate statistics for quick data validation */
    summary: OutputSummary;
  };
  data: AdHourlyRecord[];
}

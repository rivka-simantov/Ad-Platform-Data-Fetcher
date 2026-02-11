/**
 * TypeScript interfaces for the Facebook (Meta) Marketing API data model.
 *
 * Based on the Meta Marketing API Insights endpoint:
 * https://developers.facebook.com/docs/marketing-api/insights
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

/** Raw insight row returned by the Facebook Marketing API */
export interface FacebookInsightRow {
  account_id: string;
  account_currency: string;
  campaign_id: string;
  campaign_name: string;
  adset_id: string;
  adset_name: string;
  ad_id: string;
  ad_name: string;
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

/** Facebook API insights response envelope */
export interface FacebookInsightsResponse {
  data: FacebookInsightRow[];
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
  /** Ad effective status (Active, Paused, Archived, etc.) — fetched from /ads endpoint */
  status: string;

  // Metrics
  impressions: number;
  clicks: number;
  spend: number;
  purchase_roas: number | null;
  purchase_value: number | null;
  actions: ActionEntry[];
}

/** The full output file schema */
export interface OutputFile {
  metadata: {
    account_id: string;
    date: string;
    platform: string;
    fetched_at: string;
    total_records: number;
  };
  data: AdHourlyRecord[];
}

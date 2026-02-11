/**
 * Facebook (Meta) Marketing API – Ad Insights Fetcher
 *
 * This module is responsible for:
 * 1. Calling the Insights endpoint on the Meta Marketing API.
 * 2. Requesting ad-level data with hourly time breakdown.
 * 3. Handling cursor-based pagination to retrieve all rows.
 * 4. Handling Facebook-specific rate limits (error codes in JSON body).
 * 5. Normalizing the raw API response into a clean data model.
 *
 * API reference:
 *   https://developers.facebook.com/docs/marketing-api/insights
 *   https://developers.facebook.com/docs/marketing-api/insights/parameters
 *
 * Rate limiting reference:
 *   https://developers.facebook.com/docs/marketing-api/overview/rate-limiting
 *
 * Why the Insights endpoint?
 *   The /insights edge is the standard way to pull aggregated performance
 *   metrics (impressions, clicks, spend, actions, etc.) from the Meta
 *   Marketing API. By setting `level=ad` we get one row per ad, and by
 *   adding `breakdowns=hourly_stats_aggregated_by_advertiser_time_zone`
 *   we split each ad's metrics into 24 hourly buckets.
 */

import {
  FetchParams,
  FacebookInsightsResponse,
  FacebookInsightRow,
  AdHourlyRecord,
  OutputFile,
} from "./types";
import {
  BASE_URL,
  PAGE_LIMIT,
  MAX_RETRIES,
} from "./config";

// ─── Helper: sleep ───────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Facebook rate-limit error codes ─────────────────────────────────────────

/**
 * Facebook does NOT use standard HTTP 429 for rate limiting.
 * Instead, they return HTTP 400 with specific error codes in the JSON body:
 *
 *   Code 4   → App-level rate limit (Insights: subcode 1504022 / 1504039)
 *   Code 17  → Ad-account-level API limit (subcode 2446079)
 *   Code 613 → General call limit / abuse prevention
 *   Code 80000, 80003, 80004, 80014 → Business Use Case rate limits
 *
 * When rate-limited, Facebook blocks requests for a specific duration:
 *   - Development tier: 300 seconds (5 minutes)
 *   - Standard tier: 60 seconds
 *
 * We read the `X-FB-Ads-Insights-Throttle` header to check utilization %
 * and the `X-Business-Use-Case` header for estimated time to regain access.
 */
const RATE_LIMIT_ERROR_CODES = new Set([4, 17, 613, 80000, 80003, 80004, 80014]);

/** Default wait time when rate-limited (5 minutes — safe for development tier) */
const DEFAULT_RATE_LIMIT_WAIT_MS = 5 * 60 * 1000;

interface FacebookErrorResponse {
  error?: {
    code?: number;
    error_subcode?: number;
    message?: string;
  };
}

/**
 * Checks if a Facebook API JSON response contains a rate-limit error.
 */
function isRateLimitError(body: FacebookErrorResponse): boolean {
  return !!body.error?.code && RATE_LIMIT_ERROR_CODES.has(body.error.code);
}

/**
 * Extracts the recommended wait time from the `X-Business-Use-Case` header,
 * which contains `estimated_time_to_regain_access` (in minutes).
 * Falls back to a safe default if the header is missing or unparseable.
 */
function getWaitTimeFromHeaders(response: Response): number {
  // Try the X-Business-Use-Case header first
  const bucHeader = response.headers.get("x-business-use-case-usage");
  if (bucHeader) {
    try {
      const parsed = JSON.parse(bucHeader);
      // The header is keyed by account ID; pick the first one
      const firstKey = Object.keys(parsed)[0];
      if (firstKey && Array.isArray(parsed[firstKey])) {
        const entry = parsed[firstKey][0];
        if (entry?.estimated_time_to_regain_access) {
          return entry.estimated_time_to_regain_access * 60 * 1000; // minutes → ms
        }
      }
    } catch {
      // Header exists but is not parseable — fall through to default
    }
  }

  // Try the X-FB-Ads-Insights-Throttle header to log utilization
  const insightsThrottle = response.headers.get("x-fb-ads-insights-throttle");
  if (insightsThrottle) {
    try {
      const parsed = JSON.parse(insightsThrottle);
      console.warn(
        `   Insights throttle — app utilization: ${parsed.app_id_util_pct}%, ` +
          `account utilization: ${parsed.acc_id_util_pct}%`
      );
    } catch {
      // Ignore parse errors
    }
  }

  return DEFAULT_RATE_LIMIT_WAIT_MS;
}

// ─── HTTP wrapper with retry logic ───────────────────────────────────────────

/**
 * Performs a GET request using the native `fetch` API (available in Node 18+).
 * Handles:
 *   - Facebook rate-limit errors (error codes 4, 17, 613, 80000–80014):
 *     waits the recommended time from response headers, then retries.
 *   - HTTP 5xx (server error): retries with exponential backoff.
 *   - Other HTTP errors: throws immediately (no retry).
 */
async function fetchWithRetry(url: string): Promise<unknown> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url);

      // ── Server error – retry with backoff ────────────────────────────
      if (response.status >= 500) {
        const backoff = 2 ** attempt * 1000; // 2s, 4s, 8s…
        console.warn(
          `⚠  Server error ${response.status} (attempt ${attempt}/${MAX_RETRIES}). ` +
            `Retrying in ${backoff / 1000}s…`
        );
        await sleep(backoff);
        continue;
      }

      // Parse the response body
      const body = await response.json() as FacebookErrorResponse & FacebookInsightsResponse;

      // ── Facebook rate-limit error handling ────────────────────────────
      // Facebook returns rate-limit errors as HTTP 400 with error codes
      // in the JSON body, NOT as HTTP 429.
      if (body.error && isRateLimitError(body)) {
        const waitMs = getWaitTimeFromHeaders(response);
        console.warn(
          `⚠  Rate limited by Facebook (error code ${body.error.code}, ` +
            `subcode ${body.error.error_subcode ?? "none"}). ` +
            `Message: "${body.error.message}". ` +
            `Waiting ${Math.round(waitMs / 1000)}s before retry ` +
            `(attempt ${attempt}/${MAX_RETRIES})…`
        );
        await sleep(waitMs);
        continue;
      }

      // ── Other API errors – throw immediately ─────────────────────────
      if (body.error) {
        throw new Error(
          `Facebook API error (code ${body.error.code}): ${body.error.message}`
        );
      }

      if (!response.ok) {
        throw new Error(
          `Facebook API HTTP error ${response.status}: ${JSON.stringify(body)}`
        );
      }

      return body;
    } catch (err) {
      lastError = err as Error;

      // Network errors are retried
      if (
        lastError.message.includes("fetch failed") ||
        lastError.message.includes("ECONNRESET")
      ) {
        const backoff = 2 ** attempt * 1000;
        console.warn(
          `⚠  Network error (attempt ${attempt}/${MAX_RETRIES}): ${lastError.message}. ` +
            `Retrying in ${backoff / 1000}s…`
        );
        await sleep(backoff);
        continue;
      }

      throw lastError;
    }
  }

  throw new Error(
    `Failed after ${MAX_RETRIES} retries. Last error: ${lastError?.message}`
  );
}

// ─── Build the Insights API URL ──────────────────────────────────────────────

/**
 * Constructs the initial URL for the /insights endpoint.
 *
 * Key parameters:
 *   - level=ad                → one row per ad
 *   - breakdowns=hourly_stats_aggregated_by_advertiser_time_zone
 *                             → splits data into hourly buckets
 *   - time_range              → restricts to the single requested day
 *   - fields                  → the metrics and dimensions we need
 *   - limit                   → page size for cursor-based pagination
 */
function buildInsightsUrl(params: FetchParams): string {
  const { date, accountId, credentials } = params;

  // Fields we request from the API
  const fields = [
    // Dimensions / metadata
    "account_id",
    "account_currency",
    "campaign_id",
    "campaign_name",
    "adset_id",
    "adset_name",
    "ad_id",
    "ad_name",
    // Metrics
    "impressions",
    "clicks",
    "spend",
    "actions",
    "action_values",
    "purchase_roas",
  ].join(",");

  const timeRange = JSON.stringify({ since: date, until: date });

  const queryParams = new URLSearchParams({
    access_token: credentials.accessToken,
    level: "ad",
    breakdowns: "hourly_stats_aggregated_by_advertiser_time_zone",
    time_range: timeRange,
    fields,
    limit: String(PAGE_LIMIT),
  });

  return `${BASE_URL}/act_${accountId}/insights?${queryParams.toString()}`;
}

// ─── Fetch all pages of insights ─────────────────────────────────────────────

/**
 * Fetches ALL rows of insight data for the given parameters,
 * automatically following pagination cursors until no more pages remain.
 */
async function fetchAllInsights(
  params: FetchParams
): Promise<FacebookInsightRow[]> {
  const allRows: FacebookInsightRow[] = [];
  let url: string | null = buildInsightsUrl(params);
  let pageNum = 1;

  while (url) {
    console.log(`   Fetching page ${pageNum}…`);

    const response = (await fetchWithRetry(url)) as FacebookInsightsResponse;

    if (response.data && response.data.length > 0) {
      allRows.push(...response.data);
      console.log(
        `   ✓ Page ${pageNum}: received ${response.data.length} rows ` +
          `(total so far: ${allRows.length})`
      );
    } else {
      console.log(`   ✓ Page ${pageNum}: no data returned.`);
    }

    // Move to next page if available
    url = response.paging?.next ?? null;
    pageNum++;
  }

  return allRows;
}

// ─── Normalize raw data into clean output ────────────────────────────────────

/**
 * Transforms a raw Facebook insight row into our normalized AdHourlyRecord.
 *
 * Notable transformations:
 *   - Numeric strings → numbers
 *   - actions array → simplified { type, count } objects
 *   - purchase_roas / purchase action_values → extracted if present
 */
function normalizeRow(row: FacebookInsightRow): AdHourlyRecord {
  // Extract purchase ROAS (if available)
  const purchaseRoas =
    row.purchase_roas?.find((r) => r.action_type === "omni_purchase")?.value ??
    row.purchase_roas?.[0]?.value ??
    null;

  // Extract purchase / conversion value
  const purchaseValue =
    row.action_values?.find((a) => a.action_type === "omni_purchase")?.value ??
    row.action_values?.find((a) => a.action_type === "purchase")?.value ??
    null;

  // Normalize actions into a simple list
  const actions = (row.actions ?? []).map((a) => ({
    type: a.action_type,
    count: Number(a.value),
  }));

  return {
    account_id: row.account_id,
    date: row.date_start,
    hour: row.hourly_stats_aggregated_by_advertiser_time_zone,
    campaign_id: row.campaign_id,
    campaign_name: row.campaign_name,
    adset_id: row.adset_id,
    adset_name: row.adset_name,
    ad_id: row.ad_id,
    ad_name: row.ad_name,
    currency: row.account_currency,
    status: "UNKNOWN", // Enriched later via the /ads endpoint in index.ts
    impressions: Number(row.impressions),
    clicks: Number(row.clicks),
    spend: Number(row.spend),
    purchase_roas: purchaseRoas !== null ? Number(purchaseRoas) : null,
    purchase_value: purchaseValue !== null ? Number(purchaseValue) : null,
    actions,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Main entry point: fetches ad-level hourly performance data for a single day
 * from the Facebook Marketing API.
 *
 * @param params - date, accountId, and credentials
 * @returns A complete OutputFile object ready to be written to disk as JSON.
 */
export async function fetchAdData(params: FetchParams): Promise<OutputFile> {
  console.log(
    `\n📊 Fetching ad data for account ${params.accountId} on ${params.date}…\n`
  );

  const rawRows = await fetchAllInsights(params);

  if (rawRows.length === 0) {
    console.log(
      "\n⚠  No data returned for the given date and account. " +
        "The output file will contain an empty data array.\n"
    );
  }

  const normalizedData = rawRows.map(normalizeRow);

  const output: OutputFile = {
    metadata: {
      account_id: params.accountId,
      date: params.date,
      platform: "facebook",
      fetched_at: new Date().toISOString(),
      total_records: normalizedData.length,
    },
    data: normalizedData,
  };

  console.log(`\n✅ Fetched and normalized ${normalizedData.length} records.\n`);

  return output;
}

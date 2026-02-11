/**
 * Facebook (Meta) Marketing API – Ad Data Fetcher
 *
 * This module fetches ad-level hourly performance data using a SINGLE API call
 * via Facebook's Field Expansion feature. Instead of making two separate calls
 * (one for insights, one for ad status), we query the /ads endpoint and embed
 * the insights data inside each ad object using the syntax:
 *
 *   GET /act_{id}/ads?fields=effective_status,insights.time_range(...).breakdowns(...){fields...}
 *
 * This returns each ad object with its `effective_status` AND a nested
 * `insights` block containing the hourly performance metrics.
 *
 * API references:
 *   Insights API:       https://developers.facebook.com/docs/marketing-api/insights
 *   Field Expansion:    https://developers.facebook.com/docs/graph-api/using-graph-api/#field-expansion
 *   Breakdowns:         https://developers.facebook.com/docs/marketing-api/insights/breakdowns
 *   Rate Limiting:      https://developers.facebook.com/docs/marketing-api/overview/rate-limiting
 */

import {
  FetchParams,
  FacebookAdsResponse,
  FacebookAdObject,
  FacebookInsightRow,
  AdHourlyRecord,
  OutputFile,
} from "./types";
import {
  BASE_URL,
  PAGE_LIMIT,
  MAX_RETRIES,
} from "./config";
import {
  FacebookApiError,
  RateLimitError,
  AuthenticationError,
} from "./errors";

// ─── Helper: sleep ───────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Computes a backoff delay with jitter for retry attempts.
 *
 * Uses exponential backoff (2^attempt seconds) plus a random jitter of 0–1s.
 * Jitter prevents the "thundering herd" problem where multiple clients
 * that were rate-limited at the same time all retry simultaneously.
 */
function backoffWithJitter(attempt: number): number {
  const base = 2 ** attempt * 1000;       // 2s, 4s, 8s…
  const jitter = Math.random() * 1000;    // 0–1s random jitter
  return base + jitter;
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
 * When rate-limited, Facebook blocks requests for a duration that depends
 * on the API access tier:
 *   - Development tier: 300 seconds (5 minutes)
 *   - Standard tier: 60 seconds
 *
 * We read the response headers to determine the optimal wait time.
 */
const RATE_LIMIT_ERROR_CODES = new Set([4, 17, 613, 80000, 80003, 80004, 80014]);

/**
 * Facebook authentication error codes:
 *   Code 190 → Invalid or expired access token
 *   Code 10  → Insufficient permissions
 *   Code 200 → Permission error (requires specific permission)
 */
const AUTH_ERROR_CODES = new Set([190, 10, 200]);

/** Default wait time when rate-limited (5 minutes — safe for development tier) */
const DEFAULT_RATE_LIMIT_WAIT_MS = 5 * 60 * 1000;

interface FacebookErrorBody {
  error?: {
    code?: number;
    error_subcode?: number;
    message?: string;
  };
}

/**
 * Checks if a Facebook API JSON response contains a rate-limit error.
 */
function isRateLimitError(body: FacebookErrorBody): boolean {
  return !!body.error?.code && RATE_LIMIT_ERROR_CODES.has(body.error.code);
}

/**
 * Checks if a Facebook API JSON response contains an authentication error.
 */
function isAuthError(body: FacebookErrorBody): boolean {
  return !!body.error?.code && AUTH_ERROR_CODES.has(body.error.code);
}

/**
 * Extracts the recommended wait time from response headers.
 *
 * Facebook provides two relevant headers:
 *   - X-Business-Use-Case-Usage: contains `estimated_time_to_regain_access` (minutes)
 *   - X-FB-Ads-Insights-Throttle: contains utilization percentages
 *
 * Falls back to a safe default (5 min) if headers are missing or unparseable.
 */
function getWaitTimeFromHeaders(response: Response): number {
  // Try the X-Business-Use-Case-Usage header first
  const bucHeader = response.headers.get("x-business-use-case-usage");
  if (bucHeader) {
    try {
      const parsed = JSON.parse(bucHeader);
      const firstKey = Object.keys(parsed)[0];
      if (firstKey && Array.isArray(parsed[firstKey])) {
        const entry = parsed[firstKey][0];
        if (entry?.estimated_time_to_regain_access) {
          return entry.estimated_time_to_regain_access * 60 * 1000; // minutes → ms
        }
      }
    } catch {
      // Header exists but is not parseable — fall through
    }
  }

  // Log utilization from the Insights Throttle header if available
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
 * Performs a GET request with retry logic for:
 *   - Facebook rate-limit errors (codes 4, 17, 613, 80000–80014)
 *   - Server errors (HTTP 5xx) with exponential backoff + jitter
 *   - Network failures (ECONNRESET, fetch failures)
 *
 * Throws immediately (no retry) for:
 *   - Authentication errors (expired token, missing permissions)
 *   - Other client errors (bad request, etc.)
 */
async function fetchWithRetry(url: string): Promise<unknown> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url);

      // ── Server error – retry with exponential backoff + jitter ────────
      if (response.status >= 500) {
        const backoff = backoffWithJitter(attempt);
        console.warn(
          `⚠  Server error ${response.status} (attempt ${attempt}/${MAX_RETRIES}). ` +
            `Retrying in ${(backoff / 1000).toFixed(1)}s…`
        );
        await sleep(backoff);
        continue;
      }

      const body = await response.json() as FacebookErrorBody;

      // ── Authentication error – throw immediately, no retry ───────────
      if (body.error && isAuthError(body)) {
        throw new AuthenticationError(
          body.error.message ?? "Authentication failed",
          body.error.code,
          body.error.error_subcode
        );
      }

      // ── Facebook rate-limit error – wait and retry ───────────────────
      if (body.error && isRateLimitError(body)) {
        const waitMs = getWaitTimeFromHeaders(response);
        const err = new RateLimitError(
          body.error.message ?? "Rate limited",
          body.error.code,
          body.error.error_subcode,
          waitMs
        );
        console.warn(
          `⚠  ${err.name} (code ${err.code}, subcode ${err.subcode ?? "none"}). ` +
            `Message: "${err.message}". ` +
            `Waiting ${Math.round(waitMs / 1000)}s before retry ` +
            `(attempt ${attempt}/${MAX_RETRIES})…`
        );
        await sleep(waitMs);
        continue;
      }

      // ── Other API error – throw immediately ──────────────────────────
      if (body.error) {
        throw new FacebookApiError(
          body.error.message ?? "Unknown Facebook API error",
          body.error.code,
          body.error.error_subcode
        );
      }

      if (!response.ok) {
        throw new FacebookApiError(
          `HTTP error ${response.status}: ${JSON.stringify(body)}`,
          response.status,
          undefined
        );
      }

      return body;
    } catch (err) {
      // Don't retry auth errors or known API errors
      if (
        err instanceof AuthenticationError ||
        err instanceof FacebookApiError
      ) {
        throw err;
      }

      lastError = err as Error;

      // Network errors are retried with backoff + jitter
      if (
        lastError.message.includes("fetch failed") ||
        lastError.message.includes("ECONNRESET")
      ) {
        const backoff = backoffWithJitter(attempt);
        console.warn(
          `⚠  Network error (attempt ${attempt}/${MAX_RETRIES}): ${lastError.message}. ` +
            `Retrying in ${(backoff / 1000).toFixed(1)}s…`
        );
        await sleep(backoff);
        continue;
      }

      throw lastError;
    }
  }

  throw new FacebookApiError(
    `Failed after ${MAX_RETRIES} retries. Last error: ${lastError?.message}`,
    undefined,
    undefined
  );
}

// ─── Build the /ads URL with Field Expansion ─────────────────────────────────

/**
 * Constructs the URL for GET /act_{id}/ads using Field Expansion to embed
 * insights data inside each ad object.
 *
 * The resulting URL looks like:
 *   /act_{id}/ads?fields=effective_status,insights.time_range({...}).breakdowns(...){fields}
 *
 * This fetches both:
 *   - Ad object properties: id, effective_status
 *   - Nested insights: hourly metrics for the requested day
 *
 * Exported for unit testing.
 */
export function buildAdsUrl(params: FetchParams): string {
  const { date, accountId, credentials } = params;

  // Fields we want from the nested insights block
  const insightsFields = [
    "account_id",
    "account_currency",
    "campaign_id",
    "campaign_name",
    "adset_id",
    "adset_name",
    "ad_id",
    "ad_name",
    "objective",
    "impressions",
    "clicks",
    "spend",
    "actions",
    "action_values",
    "purchase_roas",
  ].join(",");

  // Build the field expansion expression for insights
  // Syntax: insights.time_range({...}).breakdowns(...){field1,field2,...}
  const timeRange = `{"since":"${date}","until":"${date}"}`;
  const insightsExpansion =
    `insights` +
    `.time_range(${timeRange})` +
    `.breakdowns(hourly_stats_aggregated_by_advertiser_time_zone)` +
    `{${insightsFields}}`;

  // Top-level fields: ad properties + nested insights
  const fields = `effective_status,${insightsExpansion}`;

  const queryParams = new URLSearchParams({
    access_token: credentials.accessToken,
    fields,
    limit: String(PAGE_LIMIT),
  });

  return `${BASE_URL}/act_${accountId}/ads?${queryParams.toString()}`;
}

// ─── Fetch all pages of ads ──────────────────────────────────────────────────

/**
 * Fetches ALL ad objects (with nested insights) from the account,
 * following pagination cursors until no more pages remain.
 */
async function fetchAllAds(params: FetchParams): Promise<FacebookAdObject[]> {
  const allAds: FacebookAdObject[] = [];
  let url: string | null = buildAdsUrl(params);
  let pageNum = 1;

  while (url) {
    console.log(`   Fetching page ${pageNum}…`);

    const response = (await fetchWithRetry(url)) as FacebookAdsResponse;

    if (response.data && response.data.length > 0) {
      allAds.push(...response.data);
      console.log(
        `   ✓ Page ${pageNum}: received ${response.data.length} ads ` +
          `(total so far: ${allAds.length})`
      );
    } else {
      console.log(`   ✓ Page ${pageNum}: no ads returned.`);
    }

    // Move to next page if available
    url = response.paging?.next ?? null;
    pageNum++;
  }

  return allAds;
}

// ─── Normalize raw data into clean output ────────────────────────────────────

/**
 * Transforms a raw Facebook insight row + ad status into a normalized record.
 *
 * Notable transformations:
 *   - Numeric strings → numbers
 *   - actions array → simplified { type, count } objects
 *   - purchase_roas / action_values → extracted if present
 *
 * Exported for unit testing.
 */
export function normalizeRow(
  row: FacebookInsightRow,
  status: string
): AdHourlyRecord {
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
    status,
    objective: row.objective,
    impressions: Number(row.impressions),
    clicks: Number(row.clicks),
    spend: Number(row.spend),
    purchase_roas: purchaseRoas !== null ? Number(purchaseRoas) : null,
    purchase_value: purchaseValue !== null ? Number(purchaseValue) : null,
    actions,
  };
}

// ─── Summary statistics ──────────────────────────────────────────────────────

/**
 * Computes aggregate summary statistics across all hourly records.
 * Included in the output metadata for quick data validation.
 */
function computeSummary(records: AdHourlyRecord[]) {
  const uniqueAds = new Set(records.map((r) => r.ad_id));
  const uniqueCampaigns = new Set(records.map((r) => r.campaign_id));
  const uniqueAdSets = new Set(records.map((r) => r.adset_id));

  return {
    total_impressions: records.reduce((sum, r) => sum + r.impressions, 0),
    total_clicks: records.reduce((sum, r) => sum + r.clicks, 0),
    total_spend: Math.round(records.reduce((sum, r) => sum + r.spend, 0) * 100) / 100,
    unique_ads: uniqueAds.size,
    unique_campaigns: uniqueCampaigns.size,
    unique_adsets: uniqueAdSets.size,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Main entry point: fetches ad-level hourly performance data for a single day
 * from the Facebook Marketing API using a single API call with Field Expansion.
 *
 * @param params - date, accountId, and credentials
 * @returns A complete OutputFile object ready to be written to disk as JSON.
 */
export async function fetchAdData(params: FetchParams): Promise<OutputFile> {
  console.log(
    `\n📊 Fetching ad data for account ${params.accountId} on ${params.date}…\n`
  );

  // Single API call: fetch ads with nested insights via field expansion
  const ads = await fetchAllAds(params);

  // Flatten: each ad may have multiple hourly insight rows
  const normalizedData: AdHourlyRecord[] = [];

  for (const ad of ads) {
    const status = ad.effective_status ?? "UNKNOWN";
    const insightRows = ad.insights?.data ?? [];

    for (const row of insightRows) {
      normalizedData.push(normalizeRow(row, status));
    }
  }

  if (normalizedData.length === 0) {
    console.log(
      "\n⚠  No data returned for the given date and account. " +
        "The output file will contain an empty data array.\n"
    );
  }

  const summary = computeSummary(normalizedData);

  const output: OutputFile = {
    metadata: {
      account_id: params.accountId,
      date: params.date,
      platform: "facebook",
      fetched_at: new Date().toISOString(),
      total_records: normalizedData.length,
      summary,
    },
    data: normalizedData,
  };

  console.log(
    `\n✅ Fetched ${ads.length} ads → ${normalizedData.length} hourly records.\n`
  );

  return output;
}

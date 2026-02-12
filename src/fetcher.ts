/**
 * Facebook (Meta) Marketing API – Ad Data Fetcher
 *
 * This module fetches ad-level hourly performance data using an
 * "insights-first" strategy:
 *
 *   1. GET /act_{id}/insights?level=ad&breakdowns=hourly_stats_aggregated_by_advertiser_time_zone
 *      → Returns ONLY ads that had activity on the requested date (with hourly metrics).
 *
 *   2. GET /?ids=ad1,ad2,...&fields=effective_status
 *      → Fetches the status (ACTIVE/PAUSED/etc.) for just those ads.
 *
 * Why not use the /ads endpoint with Field Expansion?
 *   The /ads endpoint returns ALL ads ever created in the account (including
 *   thousands of archived/paused historical ads). For large accounts, this
 *   results in fetching thousands of ad objects — most with empty insights —
 *   which is extremely slow. The Insights API only returns ads with actual data.
 *
 * API references:
 *   Insights API:       https://developers.facebook.com/docs/marketing-api/insights
 *   Breakdowns:         https://developers.facebook.com/docs/marketing-api/insights/breakdowns
 *   Rate Limiting:      https://developers.facebook.com/docs/marketing-api/overview/rate-limiting
 */

import {
  FetchParams,
  FacebookInsightsResponse,
  FacebookStatusMap,
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
 * Performs an HTTP request (GET or POST) with retry logic for:
 *   - Facebook rate-limit errors (codes 4, 17, 613, 80000–80014)
 *   - Server errors (HTTP 5xx) with exponential backoff + jitter
 *   - Network failures (ECONNRESET, fetch failures)
 *
 * Throws immediately (no retry) for:
 *   - Authentication errors (expired token, missing permissions)
 *   - Other client errors (bad request, etc.)
 *
 * @param url  - The URL to fetch
 * @param init - Optional RequestInit (e.g., { method: "POST" } for async reports)
 */
async function fetchWithRetry<T>(url: string, init?: RequestInit): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, init);

      // Parse JSON body for ALL responses (including 5xx).
      // Facebook often returns HTTP 500 with a JSON body containing a
      // specific error code (e.g., code 1 = "reduce data"). We need to
      // read the body first so we can classify the error properly.
      let body: FacebookErrorBody;
      try {
        body = await response.json() as FacebookErrorBody;
      } catch {
        // If we can't parse JSON on a 5xx, treat as a generic server error
        if (response.status >= 500) {
          const backoff = backoffWithJitter(attempt);
          console.warn(
            `⚠  Server error ${response.status} (attempt ${attempt}/${MAX_RETRIES}). ` +
              `Retrying in ${(backoff / 1000).toFixed(1)}s…`
          );
          lastError = new Error(`Server error ${response.status} (non-JSON body)`);
          await sleep(backoff);
          continue;
        }
        throw new FacebookApiError(
          `HTTP ${response.status}: non-JSON response`,
          response.status,
          undefined
        );
      }

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

      // ── Generic server error with JSON body – retry ───────────────────
      if (response.status >= 500 && body.error) {
        // Throw so the caller (e.g., fetchAllInsights) can decide whether
        // to reduce limits or just retry. This handles Facebook's code 1
        // ("Please reduce the amount of data") which arrives as HTTP 500.
        throw new FacebookApiError(
          body.error.message ?? `Server error ${response.status}`,
          body.error.code,
          body.error.error_subcode
        );
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

      return body as T;
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

// ─── Build the Insights URL ──────────────────────────────────────────────────

/**
 * Constructs the URL for GET /act_{id}/insights with ad-level hourly breakdown.
 *
 * The resulting URL looks like:
 *   /act_{id}/insights?level=ad&time_range={...}&breakdowns=hourly_stats_...&fields=...
 *
 * Unlike the /ads endpoint (which returns ALL ads ever created in the account),
 * the Insights endpoint ONLY returns ads that had actual activity (impressions,
 * clicks, spend) on the requested date. This is dramatically faster for large
 * accounts that may have thousands of historical ads.
 *
 * @param params - date, accountId, and credentials
 * @param limit  - optional page size override (defaults to PAGE_LIMIT from config).
 *
 * Exported for unit testing.
 */
export function buildInsightsUrl(params: FetchParams, limit: number = PAGE_LIMIT): string {
  const { date, accountId, credentials } = params;

  const fields = [
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

  const queryParams = new URLSearchParams({
    access_token: credentials.accessToken,
    level: "ad",
    time_range: JSON.stringify({ since: date, until: date }),
    breakdowns: "hourly_stats_aggregated_by_advertiser_time_zone",
    fields,
    limit: String(limit),
  });

  return `${BASE_URL}/act_${accountId}/insights?${queryParams.toString()}`;
}

/**
 * Constructs a URL to fetch effective_status for a batch of ad IDs.
 *
 * Uses the Graph API batch-by-IDs syntax:
 *   GET /?ids=id1,id2,...&fields=effective_status
 *
 * This is used after fetching insights to get the status of only the
 * ads that had activity — typically just a handful of IDs.
 *
 * Exported for unit testing.
 */
export function buildStatusUrl(adIds: string[], accessToken: string): string {
  const queryParams = new URLSearchParams({
    ids: adIds.join(","),
    fields: "effective_status",
    access_token: accessToken,
  });

  return `${BASE_URL}/?${queryParams.toString()}`;
}

// ─── Async Insights Report ───────────────────────────────────────────────────

/** Response from POST /act_{id}/insights (async report creation) */
interface ReportRunResponse {
  report_run_id: string;
}

/** Response from GET /{report_run_id} (report status polling) */
interface ReportStatusResponse {
  id: string;
  async_status: string;
  async_percent_completion: number;
}

/** How often to poll for report completion (in ms) */
const REPORT_POLL_INTERVAL_MS = 5_000;

/** Maximum time to wait for a report before giving up (5 minutes) */
const REPORT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Creates an async insights report via POST.
 *
 * The Facebook Insights API returns HTTP 500 with error code 1
 * ("Please reduce the amount of data") for complex queries like
 * hourly breakdowns at the ad level. The solution is to use the
 * async report flow:
 *   1. POST to create the report (this function)
 *   2. Poll until the report is ready
 *   3. Fetch the results with pagination
 *
 * @returns The report_run_id used to poll and fetch results.
 */
async function createInsightsReport(params: FetchParams): Promise<string> {
  const url = buildInsightsUrl(params);

  console.log("   Creating async insights report…");
  const response = await fetchWithRetry<ReportRunResponse>(url, { method: "POST" });

  if (!response.report_run_id) {
    throw new FacebookApiError(
      "POST /insights did not return a report_run_id",
      undefined,
      undefined
    );
  }

  console.log(`   ✓ Report created: ${response.report_run_id}`);
  return response.report_run_id;
}

/**
 * Polls a report until its async_status is "Job Completed".
 *
 * Facebook processes the report in the background. We poll every few
 * seconds and log progress percentage until it finishes.
 */
async function waitForReport(reportId: string, accessToken: string): Promise<void> {
  const statusUrl = `${BASE_URL}/${reportId}?` +
    new URLSearchParams({
      fields: "async_status,async_percent_completion",
      access_token: accessToken,
    }).toString();

  const startTime = Date.now();

  while (true) {
    const status = await fetchWithRetry<ReportStatusResponse>(statusUrl);

    if (status.async_status === "Job Completed") {
      console.log("   ✓ Report ready (100%).");
      return;
    }

    if (status.async_status === "Job Failed" || status.async_status === "Job Skipped") {
      throw new FacebookApiError(
        `Insights report failed with status: ${status.async_status}`,
        undefined,
        undefined
      );
    }

    if (Date.now() - startTime > REPORT_TIMEOUT_MS) {
      throw new FacebookApiError(
        `Insights report timed out after ${REPORT_TIMEOUT_MS / 1000}s ` +
          `(status: ${status.async_status}, ${status.async_percent_completion}%)`,
        undefined,
        undefined
      );
    }

    console.log(
      `   ⏳ Report ${status.async_status} ` +
        `(${status.async_percent_completion}%)… waiting ${REPORT_POLL_INTERVAL_MS / 1000}s`
    );
    await sleep(REPORT_POLL_INTERVAL_MS);
  }
}

/**
 * Fetches the completed report results with pagination.
 */
async function fetchReportResults(
  reportId: string,
  accessToken: string
): Promise<FacebookInsightRow[]> {
  const allRows: FacebookInsightRow[] = [];
  let url: string | null = `${BASE_URL}/${reportId}/insights?` +
    new URLSearchParams({
      access_token: accessToken,
      limit: "500",
    }).toString();
  let pageNum = 1;

  while (url) {
    console.log(`   Fetching results page ${pageNum}…`);

    const response: FacebookInsightsResponse =
      await fetchWithRetry<FacebookInsightsResponse>(url);

    if (response.data && response.data.length > 0) {
      allRows.push(...response.data);
      console.log(
        `   ✓ Page ${pageNum}: received ${response.data.length} rows ` +
          `(total so far: ${allRows.length})`
      );
    } else {
      console.log(`   ✓ Page ${pageNum}: no rows returned.`);
    }

    url = response.paging?.next ?? null;
    pageNum++;
  }

  return allRows;
}

/**
 * Fetches all insight rows using the async report workflow:
 *   1. POST to create report → returns report_run_id
 *   2. Poll GET /{id} until async_status = "Job Completed"
 *   3. GET /{id}/insights with pagination to download results
 *
 * This approach works reliably regardless of data volume, unlike the
 * synchronous GET which fails with error code 1 for complex queries.
 */
async function fetchAllInsights(params: FetchParams): Promise<FacebookInsightRow[]> {
  const reportId = await createInsightsReport(params);
  await waitForReport(reportId, params.credentials.accessToken);
  return fetchReportResults(reportId, params.credentials.accessToken);
}

// ─── Fetch ad statuses ───────────────────────────────────────────────────────

/**
 * Fetches the effective_status for a set of ad IDs using a single API call.
 *
 * Uses the Graph API batch-by-IDs syntax: GET /?ids=id1,id2,...&fields=effective_status
 * Returns a map of ad ID → status string.
 */
async function fetchAdStatuses(
  adIds: string[],
  accessToken: string
): Promise<Record<string, string>> {
  if (adIds.length === 0) return {};

  console.log(`   Fetching status for ${adIds.length} ads…`);

  const url = buildStatusUrl(adIds, accessToken);
  const response = await fetchWithRetry<FacebookStatusMap>(url);

  const statusMap: Record<string, string> = {};
  for (const [id, obj] of Object.entries(response)) {
    statusMap[id] = obj.effective_status ?? "UNKNOWN";
  }

  console.log(`   ✓ Received statuses for ${Object.keys(statusMap).length} ads.`);
  return statusMap;
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
 * Conversion note:
 *   The `purchase_roas` and `purchase_value` fields specifically target
 *   purchase-type conversions (omni_purchase / purchase). Different advertisers
 *   may track other conversion types (e.g., lead, complete_registration,
 *   add_to_cart) as their primary KPI. All conversion types are available
 *   in the `actions` array regardless — the dedicated fields are a convenience
 *   for the most common e-commerce use case.
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
 * from the Facebook Marketing API.
 *
 * Strategy (insights-first):
 *   1. Fetch insights with level=ad — returns ONLY ads with activity on the date.
 *   2. Collect unique ad IDs from the results.
 *   3. Fetch effective_status for those specific ads (single batch call).
 *   4. Merge statuses into the normalized output.
 *
 * This is dramatically faster than the /ads endpoint for large accounts,
 * which would iterate through every ad ever created.
 *
 * @param params - date, accountId, and credentials
 * @returns A complete OutputFile object ready to be written to disk as JSON.
 */
export async function fetchAdData(params: FetchParams): Promise<OutputFile> {
  console.log(
    `\n📊 Fetching ad data for account ${params.accountId} on ${params.date}…\n`
  );

  // Step 1: Fetch insights — only returns ads with activity on this date
  const insightRows = await fetchAllInsights(params);

  // Step 2: Collect unique ad IDs from the insight rows
  const uniqueAdIds = [...new Set(insightRows.map((r) => r.ad_id))];
  console.log(`\n   Found ${uniqueAdIds.length} unique ads with activity.`);

  // Step 3: Fetch statuses for those specific ads
  const statusMap = await fetchAdStatuses(
    uniqueAdIds,
    params.credentials.accessToken
  );

  // Log status distribution for visibility
  const statusCounts: Record<string, number> = {};
  for (const status of Object.values(statusMap)) {
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }
  console.log(`\n   Status distribution:`);
  for (const [status, count] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`   ├─ ${status}: ${count}`);
  }

  // Step 4: Normalize each insight row with its ad status
  const normalizedData: AdHourlyRecord[] = insightRows.map((row) => {
    const status = statusMap[row.ad_id] ?? "UNKNOWN";
    return normalizeRow(row, status);
  });

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
    `\n✅ ${uniqueAdIds.length} ads → ${normalizedData.length} hourly records.\n`
  );

  return output;
}

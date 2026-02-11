/**
 * Ad Status Fetcher
 *
 * The /insights endpoint does not return the ad's delivery status (Active,
 * Paused, Archived, etc.) when using the hourly breakdown. To satisfy the
 * assignment requirement of including status in the output, we make a
 * separate call to the /ads endpoint to retrieve the effective_status of
 * each ad that appeared in the insights data.
 *
 * API reference:
 *   https://developers.facebook.com/docs/marketing-api/reference/adgroup
 */

import { Credentials } from "./types";
import { BASE_URL, MAX_RETRIES } from "./config";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches the effective_status for a batch of ad IDs using the
 * Facebook Graph API's batch-style querying via the `ids` parameter.
 *
 * We send up to 50 IDs per request to stay within practical limits.
 */
async function fetchWithRetry(url: string): Promise<unknown> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url);

      if (response.status === 429) {
        console.warn(`⚠  Rate limited while fetching ad statuses. Waiting 60s…`);
        await sleep(60_000);
        continue;
      }

      if (response.status >= 500) {
        const backoff = 2 ** attempt * 1000;
        await sleep(backoff);
        continue;
      }

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Facebook API error ${response.status}: ${body}`);
      }

      return await response.json();
    } catch (err) {
      lastError = err as Error;
      if (
        lastError.message.includes("fetch failed") ||
        lastError.message.includes("ECONNRESET")
      ) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
      throw lastError;
    }
  }

  throw new Error(
    `Failed after ${MAX_RETRIES} retries. Last error: ${lastError?.message}`
  );
}

/**
 * Given a set of ad IDs, returns a map of adId → effective_status.
 *
 * Uses the Graph API node lookup: GET /?ids=id1,id2,...&fields=effective_status
 */
export async function fetchAdStatuses(
  adIds: string[],
  credentials: Credentials
): Promise<Map<string, string>> {
  const statusMap = new Map<string, string>();

  if (adIds.length === 0) return statusMap;

  const uniqueIds = [...new Set(adIds)];
  const BATCH_SIZE = 50;

  console.log(`   Fetching statuses for ${uniqueIds.length} unique ads…`);

  for (let i = 0; i < uniqueIds.length; i += BATCH_SIZE) {
    const batch = uniqueIds.slice(i, i + BATCH_SIZE);

    const params = new URLSearchParams({
      ids: batch.join(","),
      fields: "effective_status",
      access_token: credentials.accessToken,
    });

    const url = `${BASE_URL}/?${params.toString()}`;

    try {
      const result = (await fetchWithRetry(url)) as Record<
        string,
        { effective_status: string }
      >;

      for (const [adId, data] of Object.entries(result)) {
        statusMap.set(adId, data.effective_status ?? "UNKNOWN");
      }
    } catch (err) {
      console.warn(
        `⚠  Could not fetch statuses for batch starting at index ${i}: ` +
          `${(err as Error).message}. Status will be set to "UNKNOWN".`
      );
      // Gracefully degrade: set unknown status
      for (const id of batch) {
        statusMap.set(id, "UNKNOWN");
      }
    }
  }

  console.log(`   ✓ Fetched statuses for ${statusMap.size} ads.`);

  return statusMap;
}

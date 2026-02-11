/**
 * CLI Entry Point
 *
 * Usage:
 *   npx ts-node src/index.ts <YYYY-MM-DD>
 *
 * Or, if credentials are passed as arguments:
 *   npx ts-node src/index.ts <YYYY-MM-DD> <ACCOUNT_ID> <ACCESS_TOKEN>
 *
 * When no arguments beyond the date are given, the account ID and access
 * token are read from environment variables (FB_ACCOUNT_ID, FB_ACCESS_TOKEN).
 */

import path from "path";
import fs from "fs";
import { loadCredentialsFromEnv, validateDate } from "./config";
import { fetchAdData } from "./fetcher";
import { fetchAdStatuses } from "./statusFetcher";
import { FetchParams, OutputFile } from "./types";

// ─── Parse CLI arguments ─────────────────────────────────────────────────────

function parseArgs(): FetchParams {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error(
      "Usage:\n" +
        "  npx ts-node src/index.ts <YYYY-MM-DD>\n" +
        "  npx ts-node src/index.ts <YYYY-MM-DD> <ACCOUNT_ID> <ACCESS_TOKEN>\n"
    );
    process.exit(1);
  }

  const date = args[0];
  validateDate(date);

  // If all three args are provided, use them directly
  if (args.length >= 3) {
    return {
      date,
      accountId: args[1],
      credentials: { accessToken: args[2] },
    };
  }

  // Otherwise load from environment
  const env = loadCredentialsFromEnv();
  return {
    date,
    accountId: env.accountId,
    credentials: { accessToken: env.accessToken },
  };
}

// ─── Save output to file ─────────────────────────────────────────────────────

function saveOutput(output: OutputFile, date: string, accountId: string): string {
  const outputDir = path.resolve(__dirname, "..", "output");

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const fileName = `ad_data_${accountId}_${date}.json`;
  const filePath = path.join(outputDir, fileName);

  fs.writeFileSync(filePath, JSON.stringify(output, null, 2), "utf-8");

  return filePath;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    const params = parseArgs();

    console.log("═══════════════════════════════════════════════════════");
    console.log("  Ad Platform Data Fetcher – Facebook (Meta) Ads");
    console.log("═══════════════════════════════════════════════════════");
    console.log(`  Date      : ${params.date}`);
    console.log(`  Account   : ${params.accountId}`);
    console.log("═══════════════════════════════════════════════════════\n");

    // Step 1: Fetch ad-level hourly insights
    const output = await fetchAdData(params);

    // Step 2: Fetch ad statuses (Active, Paused, etc.) via a separate endpoint
    if (output.data.length > 0) {
      const adIds = output.data.map((row) => row.ad_id);
      const statusMap = await fetchAdStatuses(adIds, params.credentials);

      // Enrich each record with the ad's effective status
      for (const record of output.data) {
        (record as any).status = statusMap.get(record.ad_id) ?? "UNKNOWN";
      }
    }

    // Step 3: Save to local JSON file
    const filePath = saveOutput(output, params.date, params.accountId);

    console.log(`💾 Output saved to: ${filePath}`);
    console.log(`   Total records: ${output.data.length}`);
    console.log("\nDone!");
  } catch (error) {
    console.error("\n❌ Error:", (error as Error).message);
    process.exit(1);
  }
}

main();

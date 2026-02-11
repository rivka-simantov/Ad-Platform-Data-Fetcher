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
import { loadCredentialsFromEnv, validateDate, validateAccountId } from "./config";
import { fetchAdData } from "./fetcher";
import { FetchParams, OutputFile } from "./types";
import {
  ValidationError,
  AuthenticationError,
  RateLimitError,
  FacebookApiError,
} from "./errors";

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
    const accountId = args[1];
    validateAccountId(accountId);
    return {
      date,
      accountId,
      credentials: { accessToken: args[2] },
    };
  }

  // Otherwise load from environment (validation happens inside)
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

    // Fetch ad data (single API call with field expansion)
    const output = await fetchAdData(params);

    // Save to local JSON file
    const filePath = saveOutput(output, params.date, params.accountId);

    console.log(`💾 Output saved to: ${filePath}`);
    console.log(`   Total records: ${output.data.length}`);

    // Print summary
    const s = output.metadata.summary;
    console.log(`\n   Summary:`);
    console.log(`   ├─ Impressions : ${s.total_impressions.toLocaleString()}`);
    console.log(`   ├─ Clicks      : ${s.total_clicks.toLocaleString()}`);
    console.log(`   ├─ Spend       : ${s.total_spend.toFixed(2)}`);
    console.log(`   ├─ Unique ads  : ${s.unique_ads}`);
    console.log(`   ├─ Campaigns   : ${s.unique_campaigns}`);
    console.log(`   └─ Ad Sets     : ${s.unique_adsets}`);

    console.log("\nDone!");
  } catch (error) {
    // Provide user-friendly error messages based on error type
    if (error instanceof ValidationError) {
      console.error(`\n❌ Validation error: ${error.message}`);
    } else if (error instanceof AuthenticationError) {
      console.error(
        `\n❌ Authentication error (code ${error.code}): ${error.message}\n` +
          `   Please check that your access token is valid and has the "ads_read" permission.`
      );
    } else if (error instanceof RateLimitError) {
      console.error(
        `\n❌ Rate limit exceeded after retries: ${error.message}\n` +
          `   Try again in a few minutes.`
      );
    } else if (error instanceof FacebookApiError) {
      console.error(
        `\n❌ Facebook API error (code ${error.code}): ${error.message}`
      );
    } else {
      console.error("\n❌ Unexpected error:", (error as Error).message);
    }
    process.exit(1);
  }
}

main();

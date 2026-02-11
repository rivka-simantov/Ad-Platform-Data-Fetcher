/**
 * Configuration module.
 *
 * Loads credentials from environment variables (via .env file)
 * and validates them before use.
 */

import dotenv from "dotenv";
import path from "path";

// Load .env from the project root
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

/** The Facebook Graph API version we target */
export const API_VERSION = "v21.0";

/** Base URL for the Facebook Graph API */
export const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

/**
 * Maximum number of rows per page when fetching insights.
 * Facebook allows up to 500 by default; we use a reasonable batch size.
 */
export const PAGE_LIMIT = 500;

/** Maximum number of retries on transient / rate-limit errors */
export const MAX_RETRIES = 3;

/**
 * Reads credentials from environment variables.
 * Throws an informative error if any required variable is missing.
 */
export function loadCredentialsFromEnv(): {
  accessToken: string;
  accountId: string;
} {
  const accessToken = process.env.FB_ACCESS_TOKEN;
  const accountId = process.env.FB_ACCOUNT_ID;

  if (!accessToken) {
    throw new Error(
      "Missing FB_ACCESS_TOKEN environment variable. " +
        "Copy .env.example to .env and fill in your access token."
    );
  }

  if (!accountId) {
    throw new Error(
      "Missing FB_ACCOUNT_ID environment variable. " +
        "Copy .env.example to .env and fill in your ad account ID."
    );
  }

  return { accessToken, accountId };
}

/**
 * Validates that a date string matches the YYYY-MM-DD format
 * and represents a real calendar date.
 */
export function validateDate(date: string): void {
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(date)) {
    throw new Error(
      `Invalid date format: "${date}". Expected YYYY-MM-DD.`
    );
  }

  const parsed = new Date(date + "T00:00:00Z");
  if (isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: "${date}" is not a valid calendar date.`);
  }
}

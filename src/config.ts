/**
 * Configuration module.
 *
 * Loads credentials from environment variables (via .env file)
 * and validates all inputs before use.
 */

import dotenv from "dotenv";
import path from "path";
import { ValidationError } from "./errors";

// Load .env from the project root
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

/** The Facebook Graph API version we target */
export const API_VERSION = "v21.0";

/** Base URL for the Facebook Graph API */
export const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

/**
 * Maximum number of ads per page when fetching from the /ads endpoint.
 *
 * We use a conservative default (50) rather than Facebook's maximum (500)
 * because with hourly breakdowns each ad can produce up to 24 insight rows.
 * A high limit risks hitting Facebook's "data per call" threshold
 * (error subcode 1487534), which rejects the entire response.
 */
export const PAGE_LIMIT = 50;

/**
 * Minimum page limit we'll reduce to when handling data-per-call errors.
 * If we're still hitting the limit at this size, we throw instead of
 * reducing further.
 */
export const MIN_PAGE_LIMIT = 10;

/** Maximum number of retries on transient / rate-limit errors */
export const MAX_RETRIES = 3;

/**
 * Reads credentials from environment variables.
 * Throws a ValidationError if any required variable is missing.
 */
export function loadCredentialsFromEnv(): {
  accessToken: string;
  accountId: string;
} {
  const accessToken = process.env.FB_ACCESS_TOKEN;
  const accountId = process.env.FB_ACCOUNT_ID;

  if (!accessToken) {
    throw new ValidationError(
      "Missing FB_ACCESS_TOKEN environment variable. " +
        "Copy .env.example to .env and fill in your access token."
    );
  }

  if (!accountId) {
    throw new ValidationError(
      "Missing FB_ACCOUNT_ID environment variable. " +
        "Copy .env.example to .env and fill in your ad account ID."
    );
  }

  // Validate the account ID before returning
  validateAccountId(accountId);

  return { accessToken, accountId };
}

/**
 * Validates that a date string matches the YYYY-MM-DD format
 * and represents a real calendar date.
 */
export function validateDate(date: string): void {
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(date)) {
    throw new ValidationError(
      `Invalid date format: "${date}". Expected YYYY-MM-DD.`
    );
  }

  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  // Check that the Date object matches the input — if Date rolled over
  // (e.g., Feb 30 → Mar 2), the values won't match.
  if (
    isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new ValidationError(
      `Invalid date: "${date}" is not a valid calendar date.`
    );
  }
}

/**
 * Validates that the account ID is a numeric string.
 *
 * Facebook ad account IDs are purely numeric (e.g., "123456789").
 * The "act_" prefix is added by our code — if the user passes "act_123",
 * the URL would become "act_act_123" which would fail.
 */
export function validateAccountId(accountId: string): void {
  if (!/^\d+$/.test(accountId)) {
    throw new ValidationError(
      `Invalid account ID: "${accountId}". ` +
        `Expected a numeric string (without the "act_" prefix). ` +
        `Example: "123456789".`
    );
  }
}

/**
 * Unit tests for the Ad Platform Data Fetcher.
 *
 * Tests cover:
 *   - Input validation (date format, account ID format)
 *   - Data normalization (Facebook API response → clean output)
 *   - URL construction (field expansion, breakdowns, time range)
 *   - Custom error classes
 */

import { validateDate, validateAccountId } from "./config";
import { normalizeRow, buildInsightsUrl, buildStatusUrl } from "./fetcher";
import { FacebookInsightRow, FetchParams } from "./types";
import {
  FacebookApiError,
  RateLimitError,
  AuthenticationError,
  ValidationError,
} from "./errors";

// ─── validateDate ────────────────────────────────────────────────────────────

describe("validateDate", () => {
  it("accepts a valid date in YYYY-MM-DD format", () => {
    expect(() => validateDate("2025-01-15")).not.toThrow();
    expect(() => validateDate("2024-12-31")).not.toThrow();
    expect(() => validateDate("2025-02-28")).not.toThrow();
  });

  it("rejects dates with wrong format", () => {
    expect(() => validateDate("01-15-2025")).toThrow(ValidationError);
    expect(() => validateDate("2025/01/15")).toThrow(ValidationError);
    expect(() => validateDate("20250115")).toThrow(ValidationError);
    expect(() => validateDate("Jan 15, 2025")).toThrow(ValidationError);
  });

  it("rejects empty or garbage strings", () => {
    expect(() => validateDate("")).toThrow(ValidationError);
    expect(() => validateDate("not-a-date")).toThrow(ValidationError);
  });

  it("rejects invalid calendar dates", () => {
    // February 30 doesn't exist
    expect(() => validateDate("2025-02-30")).toThrow(ValidationError);
    // Month 13 doesn't exist
    expect(() => validateDate("2025-13-01")).toThrow(ValidationError);
  });
});

// ─── validateAccountId ───────────────────────────────────────────────────────

describe("validateAccountId", () => {
  it("accepts numeric account IDs", () => {
    expect(() => validateAccountId("123456789")).not.toThrow();
    expect(() => validateAccountId("1")).not.toThrow();
    expect(() => validateAccountId("99999999999999")).not.toThrow();
  });

  it('rejects account IDs with "act_" prefix', () => {
    expect(() => validateAccountId("act_123456789")).toThrow(ValidationError);
  });

  it("rejects non-numeric account IDs", () => {
    expect(() => validateAccountId("abc")).toThrow(ValidationError);
    expect(() => validateAccountId("123abc")).toThrow(ValidationError);
    expect(() => validateAccountId("")).toThrow(ValidationError);
  });
});

// ─── normalizeRow ────────────────────────────────────────────────────────────

describe("normalizeRow", () => {
  const baseRow: FacebookInsightRow = {
    account_id: "123456",
    account_currency: "USD",
    campaign_id: "camp_1",
    campaign_name: "Test Campaign",
    adset_id: "adset_1",
    adset_name: "Test Ad Set",
    ad_id: "ad_1",
    ad_name: "Test Ad",
    objective: "OUTCOME_SALES",
    impressions: "1500",
    clicks: "42",
    spend: "12.34",
    date_start: "2025-01-15",
    date_stop: "2025-01-15",
    hourly_stats_aggregated_by_advertiser_time_zone: "08:00:00 - 08:59:59",
  };

  it("converts string metrics to numbers", () => {
    const result = normalizeRow(baseRow, "ACTIVE");
    expect(result.impressions).toBe(1500);
    expect(result.clicks).toBe(42);
    expect(result.spend).toBe(12.34);
    expect(typeof result.impressions).toBe("number");
    expect(typeof result.clicks).toBe("number");
    expect(typeof result.spend).toBe("number");
  });

  it("maps metadata fields correctly", () => {
    const result = normalizeRow(baseRow, "PAUSED");
    expect(result.account_id).toBe("123456");
    expect(result.date).toBe("2025-01-15");
    expect(result.hour).toBe("08:00:00 - 08:59:59");
    expect(result.campaign_id).toBe("camp_1");
    expect(result.adset_id).toBe("adset_1");
    expect(result.ad_id).toBe("ad_1");
    expect(result.currency).toBe("USD");
    expect(result.status).toBe("PAUSED");
    expect(result.objective).toBe("OUTCOME_SALES");
  });

  it("returns null for purchase_roas when not available", () => {
    const result = normalizeRow(baseRow, "ACTIVE");
    expect(result.purchase_roas).toBeNull();
    expect(result.purchase_value).toBeNull();
  });

  it("extracts purchase_roas from omni_purchase", () => {
    const rowWithRoas: FacebookInsightRow = {
      ...baseRow,
      purchase_roas: [
        { action_type: "omni_purchase", value: "3.52" },
      ],
    };
    const result = normalizeRow(rowWithRoas, "ACTIVE");
    expect(result.purchase_roas).toBe(3.52);
  });

  it("extracts purchase_value from action_values", () => {
    const rowWithValue: FacebookInsightRow = {
      ...baseRow,
      action_values: [
        { action_type: "omni_purchase", value: "150.00" },
        { action_type: "link_click", value: "0" },
      ],
    };
    const result = normalizeRow(rowWithValue, "ACTIVE");
    expect(result.purchase_value).toBe(150);
  });

  it("normalizes actions array correctly", () => {
    const rowWithActions: FacebookInsightRow = {
      ...baseRow,
      actions: [
        { action_type: "link_click", value: "42" },
        { action_type: "omni_purchase", value: "3" },
        { action_type: "page_engagement", value: "10" },
      ],
    };
    const result = normalizeRow(rowWithActions, "ACTIVE");
    expect(result.actions).toHaveLength(3);
    expect(result.actions[0]).toEqual({ type: "link_click", count: 42 });
    expect(result.actions[1]).toEqual({ type: "omni_purchase", count: 3 });
    expect(result.actions[2]).toEqual({ type: "page_engagement", count: 10 });
  });

  it("returns empty actions array when no actions", () => {
    const result = normalizeRow(baseRow, "ACTIVE");
    expect(result.actions).toEqual([]);
  });
});

// ─── buildInsightsUrl ────────────────────────────────────────────────────────

describe("buildInsightsUrl", () => {
  const params: FetchParams = {
    date: "2025-01-15",
    accountId: "123456789",
    credentials: { accessToken: "test_token_123" },
  };

  it("targets the /insights endpoint with the correct account ID", () => {
    const url = buildInsightsUrl(params);
    expect(url).toContain("/act_123456789/insights");
  });

  it("includes the access token", () => {
    const url = buildInsightsUrl(params);
    expect(url).toContain("access_token=test_token_123");
  });

  it("uses level=ad to get ad-level data", () => {
    const url = buildInsightsUrl(params);
    expect(url).toContain("level=ad");
  });

  it("includes hourly breakdown", () => {
    const url = buildInsightsUrl(params);
    expect(url).toContain("breakdowns=hourly_stats_aggregated_by_advertiser_time_zone");
  });

  it("includes the correct time_range for the requested date", () => {
    const url = decodeURIComponent(buildInsightsUrl(params));
    expect(url).toContain('"since":"2025-01-15"');
    expect(url).toContain('"until":"2025-01-15"');
  });

  it("requests all required metrics in the fields", () => {
    const url = buildInsightsUrl(params);
    const requiredFields = [
      "impressions", "clicks", "spend", "actions",
      "action_values", "purchase_roas", "account_id",
      "campaign_id", "adset_id", "ad_id", "objective",
    ];
    for (const field of requiredFields) {
      expect(url).toContain(field);
    }
  });

  it("includes the default page limit", () => {
    const url = buildInsightsUrl(params);
    expect(url).toContain("limit=25");
  });

  it("accepts a custom page limit override", () => {
    const url = buildInsightsUrl(params, 25);
    expect(url).toContain("limit=25");
  });
});

// ─── buildStatusUrl ──────────────────────────────────────────────────────────

describe("buildStatusUrl", () => {
  it("includes all ad IDs", () => {
    const url = buildStatusUrl(["111", "222", "333"], "test_token");
    const decoded = decodeURIComponent(url);
    expect(decoded).toContain("ids=111,222,333");
  });

  it("requests effective_status field", () => {
    const url = buildStatusUrl(["111"], "test_token");
    expect(url).toContain("fields=effective_status");
  });

  it("includes the access token", () => {
    const url = buildStatusUrl(["111"], "test_token");
    expect(url).toContain("access_token=test_token");
  });
});

// ─── Custom Error Classes ────────────────────────────────────────────────────

describe("Custom Error Classes", () => {
  it("FacebookApiError stores code and subcode", () => {
    const err = new FacebookApiError("test error", 100, 12345);
    expect(err.message).toBe("test error");
    expect(err.code).toBe(100);
    expect(err.subcode).toBe(12345);
    expect(err.name).toBe("FacebookApiError");
    expect(err instanceof Error).toBe(true);
  });

  it("RateLimitError stores retryAfterMs", () => {
    const err = new RateLimitError("rate limited", 4, 1504022, 300000);
    expect(err.retryAfterMs).toBe(300000);
    expect(err.code).toBe(4);
    expect(err.name).toBe("RateLimitError");
    expect(err instanceof FacebookApiError).toBe(true);
  });

  it("AuthenticationError extends FacebookApiError", () => {
    const err = new AuthenticationError("token expired", 190, undefined);
    expect(err.name).toBe("AuthenticationError");
    expect(err.code).toBe(190);
    expect(err instanceof FacebookApiError).toBe(true);
  });

  it("ValidationError is independent from FacebookApiError", () => {
    const err = new ValidationError("bad input");
    expect(err.name).toBe("ValidationError");
    expect(err instanceof Error).toBe(true);
    expect(err instanceof FacebookApiError).toBe(false);
  });
});

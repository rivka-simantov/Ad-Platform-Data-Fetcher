# Ad Platform Data Fetcher

A TypeScript CLI tool that fetches **ad-level, hourly performance data** from the **Facebook (Meta) Marketing API** for a specific day and saves it as a local JSON file.

## Platform: Facebook (Meta) Marketing API

This tool uses a **single API call** with [Field Expansion](https://developers.facebook.com/docs/graph-api/using-graph-api/#field-expansion) to fetch both ad properties and performance metrics in one request:

```
GET /act_{id}/ads?fields=effective_status,insights.time_range(...).breakdowns(...){metrics...}
```

**Why this approach?**
Instead of making two separate calls (one for insights, one for ad status), Field Expansion allows us to query the `/ads` endpoint and embed the insights data inside each ad object. This means we get `effective_status` (Active, Paused, etc.) and all performance metrics (impressions, clicks, spend, etc.) in a single request.

**Why the Insights edge?**
The `/insights` edge is the standard reporting endpoint in the Meta Marketing API ([docs](https://developers.facebook.com/docs/marketing-api/insights)). By using `breakdowns=hourly_stats_aggregated_by_advertiser_time_zone` ([docs](https://developers.facebook.com/docs/marketing-api/insights/breakdowns)), we get one row per ad per hour — exactly the granularity required.

## Prerequisites

- **Node.js** 18+ (uses native `fetch`)
- A valid **Facebook (Meta) Marketing API Access Token** with `ads_read` permission
- The **Ad Account ID** (numeric, without the `act_` prefix)

## Setup

```bash
# 1. Clone the repository
git clone <repo-url>
cd Ad-Platform-Data-Fetcher

# 2. Install dependencies
npm install

# 3. Configure credentials
cp .env.example .env
# Edit .env and fill in your access token and account ID
```

### `.env` file format

```env
FB_ACCESS_TOKEN=your_access_token_here
FB_ACCOUNT_ID=your_account_id_here
```

## Usage

### Option 1: Using environment variables (recommended)

```bash
npm start -- 2025-01-15
```

### Option 2: Passing credentials as arguments

```bash
npx ts-node src/index.ts 2025-01-15 <ACCOUNT_ID> <ACCESS_TOKEN>
```

### Output

The script generates a JSON file at:

```
output/ad_data_<ACCOUNT_ID>_<DATE>.json
```

### Running Tests

```bash
npm test
```

## Output Schema

```jsonc
{
  "metadata": {
    "account_id": "123456789",
    "date": "2025-01-15",
    "platform": "facebook",
    "fetched_at": "2025-01-16T08:30:00.000Z",
    "total_records": 48,
    "summary": {
      "total_impressions": 45000,
      "total_clicks": 1200,
      "total_spend": 350.50,
      "unique_ads": 15,
      "unique_campaigns": 3,
      "unique_adsets": 5
    }
  },
  "data": [
    {
      // Metadata
      "account_id": "123456789",
      "date": "2025-01-15",
      "hour": "08:00:00 - 08:59:59",
      "campaign_id": "120210000000000001",
      "campaign_name": "Winter Sale 2025",
      "adset_id": "120210000000000010",
      "adset_name": "Lookalike - US - 25-45",
      "ad_id": "120210000000000100",
      "ad_name": "Video Ad - Discount 20%",
      "currency": "USD",
      "status": "ACTIVE",
      "objective": "OUTCOME_SALES",
      // Metrics
      "impressions": 1250,
      "clicks": 45,
      "spend": 12.34,
      "purchase_roas": 3.52,
      "purchase_value": 43.44,
      "actions": [
        { "type": "link_click", "count": 45 },
        { "type": "omni_purchase", "count": 3 }
      ]
    }
  ]
}
```

## Data Fields

### Metadata (per record)

| Field | Description |
|---|---|
| `account_id` | The ad account identifier |
| `date` | The date (YYYY-MM-DD) |
| `hour` | Hourly time bucket (e.g., `08:00:00 - 08:59:59`) |
| `campaign_id` | Facebook campaign ID |
| `campaign_name` | Campaign display name |
| `adset_id` | Ad Set ID |
| `adset_name` | Ad Set display name |
| `ad_id` | Ad ID |
| `ad_name` | Ad display name |
| `currency` | Account currency (e.g., USD, EUR) |
| `status` | Ad effective status (ACTIVE, PAUSED, ARCHIVED, etc.) |
| `objective` | Campaign objective (e.g., OUTCOME_SALES, OUTCOME_TRAFFIC) |

### Metrics (per record)

| Field | Description |
|---|---|
| `impressions` | Number of times the ad was displayed |
| `clicks` | Number of clicks |
| `spend` | Amount spent in the account currency |
| `purchase_roas` | Return on ad spend for purchases (null if no purchase data) |
| `purchase_value` | Total purchase conversion value (null if no purchase data) |
| `actions` | Array of all action types and counts (conversions, clicks, etc.) |

## Technical Details

### Field Expansion (Single API Call)

We use Facebook's [Field Expansion](https://developers.facebook.com/docs/graph-api/using-graph-api/#field-expansion) feature to combine what would normally be two separate API calls into one. The query:

```
/act_{id}/ads?fields=effective_status,insights.time_range({"since":"2025-01-15","until":"2025-01-15"}).breakdowns(hourly_stats_aggregated_by_advertiser_time_zone){impressions,clicks,spend,...}
```

Returns each ad with its status AND its hourly performance data nested inside.

### Pagination

Facebook uses **cursor-based pagination**. The script follows the `paging.next` URL automatically until no more pages are available. Pagination happens at the ads level — each page returns up to 500 ads, each with their nested hourly insights.

### Rate Limiting

Facebook does **not** use standard HTTP 429 responses ([docs](https://developers.facebook.com/docs/marketing-api/overview/rate-limiting/)). Instead, rate-limit errors are returned as JSON with specific error codes (`4`, `17`, `613`, `80000`, `80003`, `80004`, `80014`).

The script handles this by:
- Detecting Facebook-specific rate-limit error codes in the response body.
- Reading the `X-Business-Use-Case-Usage` header for the recommended wait time (`estimated_time_to_regain_access`).
- Logging utilization percentages from the `X-FB-Ads-Insights-Throttle` header.
- Falling back to a 5-minute wait (safe for the Development tier) if headers are unavailable.
- Retrying up to 3 times with exponential backoff + **random jitter** to avoid thundering herd.

Server errors (5xx) and network errors are retried with exponential backoff + jitter.

### Input Validation

All inputs are validated before making API calls:
- **Date**: Must be in `YYYY-MM-DD` format and represent a real calendar date (e.g., `2025-02-30` is rejected).
- **Account ID**: Must be a numeric string. If the user accidentally includes the `act_` prefix, a clear error message explains the expected format.
- **Credentials**: Missing environment variables produce actionable error messages.

### Error Handling

The script uses **custom error classes** for precise error handling:

| Error Class | When | Retry? |
|---|---|---|
| `ValidationError` | Invalid date, bad account ID, missing credentials | No |
| `AuthenticationError` | Expired token, insufficient permissions (codes 190, 10, 200) | No |
| `RateLimitError` | API rate limit exceeded (codes 4, 17, 613, 80000+) | Yes, with wait |
| `FacebookApiError` | Other API errors | No |

Each error type produces a user-friendly message with actionable guidance.

## Project Structure

```
├── src/
│   ├── index.ts          # CLI entry point, orchestration
│   ├── fetcher.ts        # Ads + Insights fetcher (field expansion, pagination, rate limiting)
│   ├── config.ts         # Configuration, env loading, input validation
│   ├── errors.ts         # Custom error classes
│   ├── types.ts          # TypeScript interfaces
│   └── index.test.ts     # Unit tests (25 tests)
├── output/               # Generated JSON files
├── .env.example          # Template for credentials
├── .gitignore
├── jest.config.ts        # Test configuration
├── package.json
├── tsconfig.json
└── README.md
```

## Generating the Example Output

To generate the example output file, configure your `.env` with real credentials and run:

```bash
npm start -- 2025-01-15
```

The output will be saved to `output/ad_data_<ACCOUNT_ID>_<DATE>.json`.

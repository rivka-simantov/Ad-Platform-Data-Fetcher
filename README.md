# Ad Platform Data Fetcher

A TypeScript CLI tool that fetches **ad-level, hourly performance data** from the **Facebook (Meta) Marketing API** for a specific day and saves it as a local JSON file.

## Platform: Facebook (Meta) Marketing API

This tool uses two Facebook Graph API endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /act_{id}/insights` | Fetch performance metrics (impressions, clicks, spend, ROAS, actions) at ad level with hourly breakdown |
| `GET /?ids={ad_ids}` | Fetch effective status (Active, Paused, etc.) for each ad |

**Why the Insights endpoint?**
The `/insights` edge is the standard reporting endpoint in the Meta Marketing API. By setting `level=ad` and `breakdowns=hourly_stats_aggregated_by_advertiser_time_zone`, we get one row per ad per hour — exactly the granularity required.

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

## Output Schema

```jsonc
{
  "metadata": {
    "account_id": "123456789",
    "date": "2025-01-15",
    "platform": "facebook",
    "fetched_at": "2025-01-16T08:30:00.000Z",
    "total_records": 48
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

### Pagination

Facebook uses **cursor-based pagination**. The script follows the `paging.next` URL until no more pages are available, ensuring all data for the day is retrieved.

### Rate Limiting

The script handles HTTP 429 responses by waiting 60 seconds before retrying. Server errors (5xx) are retried with exponential backoff (2s, 4s, 8s). A maximum of 3 retries is attempted.

### Error Handling

- **Missing credentials**: Clear error message pointing to `.env` setup
- **Invalid date format**: Validates YYYY-MM-DD before making API calls
- **Authentication errors (401/403)**: Reported immediately with the API error message
- **Empty data**: Produces a valid JSON file with an empty `data` array
- **Network errors**: Retried with backoff

## Project Structure

```
├── src/
│   ├── index.ts          # CLI entry point, orchestration
│   ├── fetcher.ts        # Insights API fetcher with pagination
│   ├── statusFetcher.ts  # Ad status fetcher (/ads endpoint)
│   ├── config.ts         # Configuration, env loading, validation
│   └── types.ts          # TypeScript interfaces
├── output/               # Generated JSON files
├── .env.example          # Template for credentials
├── .gitignore
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

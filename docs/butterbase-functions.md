# SocialButter on Butterbase Functions

Pure-HTTP backend layer ported to Butterbase Functions (serverless, V8 isolates,
Web API runtime). These cover the "no browser needed" half of the backend.

The browser-agent half (Playwright + persistent Chrome profile) cannot run on
Cloudflare's V8 runtime — that lives on localhost today and would move to a
Fly.io / Render / Railway VM for production.

App: `app_3moov7i9bzwb` (subdomain: `socialbutter`)

## Deployed functions

### 1. `luma-fetch` — Luma event scrape

Takes one or many `lu.ma/<event>` URLs or a personal `api.lu.ma/ics/...` calendar
subscription URL. Returns parsed events from `__NEXT_DATA__` / JSON-LD / OG fallback.

- **URL:** `https://api.butterbase.ai/v1/app_3moov7i9bzwb/fn/luma-fetch`
- **Method:** POST
- **Auth:** none (public)
- **Body:** `{ "input": string }`
- **Replaces:** `/api/luma/import` (pure-HTTP path, not the ICS-via-browser path)

```bash
curl -X POST https://api.butterbase.ai/v1/app_3moov7i9bzwb/fn/luma-fetch \
  -H 'content-type: application/json' \
  -d '{"input":"https://lu.ma/some-event"}'
```

### 2. `calendar-fetch` — multi-source ICS parser

Takes any calendar subscription URL: Luma ICS, Google Calendar ICS,
Apple `webcal://`, or generic ICS. Auto-detects the source and returns
events with `sourceLabel` set accordingly.

- **URL:** `https://api.butterbase.ai/v1/app_3moov7i9bzwb/fn/calendar-fetch`
- **Method:** POST
- **Auth:** none (public)
- **Body:** `{ "input": string }`
- **Replaces:** `/api/calendar/import` (the URL-paste path)
- **Verified live:** US-holiday Google Calendar returns 3000+ real events.

### 3. `rank-events` — LLM ranker

Takes events from any source + optional user goal + optional Evermind memories.
Returns verdicts (`go` / `skip` / `maybe`) with cited memory ids.

- **URL:** `https://api.butterbase.ai/v1/app_3moov7i9bzwb/fn/rank-events`
- **Method:** POST
- **Auth:** none (public)
- **Body:** `{ "events": RankableEvent[], "goal"?: string, "memories"?: Memory[] }`
- **Replaces:** `/api/rank`
- **Status:** deployed; **needs `BUTTERBASE_API_KEY` env var** with `ai:gateway`
  scope. Mint a key via dashboard `/api-keys`, then:

  ```
  manage_function(action="update_env", function_name="rank-events",
                  env={"BUTTERBASE_API_KEY": "bb_sk_..."})
  ```

  Once set, calls the Butterbase AI gateway internally — usage hits the Pro
  plan's $10/mo AI credits.

## What is NOT ported (and won't be without a real Node host)

The browser-agent backend depends on:
- A long-lived process (persistent Chrome profile)
- A real filesystem (cookies stored at `~/.socialbutter-browser-profile`)
- A Chromium binary on disk
- The ability to launch a child process

V8 isolates don't give us any of these. For production, the browser-agent
deploys to Fly.io / Render / Railway — separate host. Frontend on Butterbase
(static export), backend functions on Butterbase (these three), browser-agent
on a Fly VM. Three surfaces, one product.

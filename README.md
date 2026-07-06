# Weld & Arrow Site

Cloudflare Worker + static chat UI for a repository-grounded WeldAndArrow guide.

The Worker gates each user message with Claude Haiku 4.5, answers on-topic parts
with Claude Fable 5, records consented transcripts in EU-jurisdiction Durable
Objects, and keeps the cached repository context warm while the site is active.

## Setup

1. Create the Cloudflare KV namespace used by `STATE` and put its ID in
   `wrangler.toml`.
2. Create a Turnstile widget and set `TURNSTILE_SITE_KEY` in `wrangler.toml`.
3. Set `ARTIFACT_URL` and replace `PRIVACY_CONTACT` in `public/privacy.html`.
4. Add Worker secrets:

   ```sh
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put ADMIN_TOKEN
   npx wrangler secret put TURNSTILE_SECRET
   ```

5. Add GitHub repository secrets:

   - `CLOUDFLARE_API_TOKEN`
   - `SOURCE_READ_TOKEN`

The deploy workflow fetches the current Claude pricing table, builds
`src/context.generated.ts` from the `WeldAndArrow` source checkout, typechecks,
and deploys with the source commit hash injected as `COMMIT_HASH`.

## Source Repo Notification

Add this workflow to `weld-and-arrow/.github/workflows/notify-site.yml` so pushes
to the source repo redeploy the site with a fresh frozen context:

```yaml
name: Notify site

on:
  push:
    branches: [main]

jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - name: Dispatch site rebuild
        env:
          GH_TOKEN: ${{ secrets.SITE_DISPATCH_TOKEN }}
          SITE_REPO: ${{ github.repository_owner }}/website
          SOURCE_SHA: ${{ github.sha }}
        run: |
          gh api "repos/${SITE_REPO}/dispatches" \
            --method POST \
            --field event_type=source-push \
            --raw-field client_payload="{\"sha\":\"${SOURCE_SHA}\"}"
```

`SITE_DISPATCH_TOKEN` should be a fine-grained token or GitHub App token allowed
to call `repository_dispatch` on the site repository.

## Domains

Serve the Worker at `weld-and-arrow.net`. In Cloudflare, add a redirect rule:

```text
weldandarrow.net/* -> https://weld-and-arrow.net/$1
```

Use status code `301`.

## Local Context Build

```sh
pnpm install
node scripts/build-context.mjs --source ../weld-and-arrow --out src/context.generated.ts
pnpm run check
```

`src/context.generated.ts` is intentionally ignored because every deploy freezes
the current source checkout.

## Admin Endpoints

All admin endpoints require `Authorization: Bearer <ADMIN_TOKEN>`.

- `GET /admin/transcripts/search?q=&from=&to=&session=`
- `DELETE /admin/transcripts?sessions=AAAA-BBBB,CCCC-DDDD`
- `GET /admin/spend`

Erasure requests can cite either the displayed session ID or a topic plus an
approximate time window.

## Acceptance Checks

- General Buddhism, such as "Did the Buddha teach the Four Noble Truths?", must
  return literal `Mu` after the Haiku gate.
- Mixed prompts must answer only the WeldAndArrow part.
- With `LIMIT_HOUR_USD=0.000001`, `/api/chat` should return `429` with
  `resetsAt` and the artifact URL.
- Two close Fable calls should show cache read tokens on the second call.
- Fresh `lastActivity` lets the warm cron run; stale or absent `lastActivity`
  skips it.
- Admin search/delete and daily retention purge should remove matching sessions.

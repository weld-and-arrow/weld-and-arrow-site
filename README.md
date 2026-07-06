# Weld & Arrow Site

Cloudflare Worker + static self-serve UI for a repository-grounded WeldAndArrow guide.

The hosted chat code is still present, but disabled by default because the full
repository context is currently too expensive to serve interactively. The home
page points visitors to a frozen context snapshot or the public GitHub repository
so they can use their own Claude account instead.

## Setup

1. Create the Cloudflare KV namespace used by `STATE` and put its ID in
   `wrangler.toml`.
2. Leave `CHAT_ENABLED=false` unless the hosted chat is affordable again.
3. Set `ARTIFACT_URL` and replace `PRIVACY_CONTACT` in `public/privacy.html`.
4. For the future hosted chat path, create a Turnstile widget, set
   `TURNSTILE_SITE_KEY` in `wrangler.toml`, and add Worker secrets:

   ```sh
   npx wrangler secret put ANTHROPIC_API_KEY
   npx wrangler secret put ADMIN_TOKEN
   npx wrangler secret put TURNSTILE_SECRET
   ```

5. Add GitHub repository secrets:

   - `CLOUDFLARE_API_TOKEN`
   - `SOURCE_READ_TOKEN`

The deploy workflow fetches the current Claude pricing table, builds
`src/context.generated.ts` from the `WeldAndArrow` source checkout, writes the
public frozen context bundle, typechecks, and deploys with the source commit hash
injected as `COMMIT_HASH`. Until `CLOUDFLARE_API_TOKEN` is configured, the
workflow warns and skips only the final deploy step.

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
node scripts/build-context.mjs --source ../weld-and-arrow --out src/context.generated.ts --repo-url https://github.com/weld-and-arrow/weld-and-arrow
pnpm run check
```

`src/context.generated.ts` is intentionally ignored because every deploy freezes
the current source checkout. The same build also writes
`public/context/weld-and-arrow.txt` and `public/context/manifest.json`; the
directory is ignored because those files are generated from the source checkout.

## Self-Serve Use

`GET /` serves an unrecorded alternatives page. `GET /use-your-own` is kept as
an alias for older links.

- Download the snapshot at `/context/weld-and-arrow.txt` and drag it into a
  Claude chat or Project. This keeps answers pinned to the exact frozen commit
  used by the deployed site.
- Connect Claude's GitHub connector to the public source repository. This avoids
  downloading a file, but Claude reads live `main`, so answers can drift from the
  frozen site context.

The page fetches `/context/manifest.json` for commit/date/size metadata and
`/api/config` so the configured `ARTIFACT_URL` remains visible in the footer.

## Hosted Chat

When `CHAT_ENABLED` is not set to literal `true`, `POST /api/session` and
`POST /api/chat` return `503` with `error: "chat_disabled"`, and the warm cron
skips cache warming. The chat UI code in `public/app.js` and the Worker chat
handlers are intentionally retained for a future re-enable.

If the hosted chat is re-enabled, the Worker gates each user message with Claude
Haiku 4.5, answers on-topic parts with Claude Fable 5, records consented
transcripts in EU-jurisdiction Durable Objects, and keeps the cached repository
context warm while the site is active.

## Admin Endpoints

All admin endpoints require `Authorization: Bearer <ADMIN_TOKEN>`.

- `GET /admin/transcripts/search?q=&from=&to=&session=`
- `DELETE /admin/transcripts?sessions=AAAA-BBBB,CCCC-DDDD`
- `GET /admin/spend`

Erasure requests can cite either the displayed session ID or a topic plus an
approximate time window.

## Acceptance Checks

- `/` should show the self-serve snapshot and GitHub connector choices without
  loading Turnstile or `public/app.js`.
- `/use-your-own` should serve the same home page.
- With default `CHAT_ENABLED=false`, `POST /api/session` and `POST /api/chat`
  should return `503` with `error: "chat_disabled"`.
- With default `CHAT_ENABLED=false`, the warm cron should skip cache warming.
- Admin search/delete and daily retention purge should remove matching sessions.
- After a local context build, `/context/weld-and-arrow.txt` should exist and
  `public/context/manifest.json`'s `commit` should equal `SOURCE_COMMIT` in
  `src/context.generated.ts`.

When `CHAT_ENABLED=true`, the older hosted-chat checks apply: general Buddhism
must return literal `Mu` after the Haiku gate; mixed prompts must answer only the
WeldAndArrow part; a tiny `LIMIT_HOUR_USD` should make `/api/chat` return `429`;
two close Fable calls should show cache read tokens on the second call; and fresh
`lastActivity` should allow the warm cron to run.

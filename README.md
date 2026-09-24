# Meera Content Bot

A personal Telegram bot that turns Meera Pillai's raw notes into voice-matched,
cited LinkedIn drafts for her to approve or discard. Runs on Vercel via a
Telegram webhook.

Read [`meera_automation_brief.pdf`](../) (sent alongside this project) first —
it explains the design decisions baked into this code, in particular **"the
Cut"**: news/data enrichment is included, but every externally-sourced fact is
always shown with its source and marked unverified. Approving a draft here
never means it's been fact-checked — that's still on Meera before she
actually posts it.

## What it does

- **New note** (any message that doesn't start with `feedback on post draft:`):
  1. Extracts a specific checkable angle, plus a generic public search phrase.
  2. Researches that phrase via free Google News RSS (no API key).
  3. Rates the note 1-10 on five parameters — **Relevance, Recency, Context,
     Content, Checkability** — using the note and that research together.
  4. **Score < 7** → backlogged, reply shows the score and the full breakdown.
     **7** = low-confidence postable, **8** = medium, **9-10** = high — all
     three tiers get drafted.
  5. If postable: drafts a LinkedIn post in her voice and sends it with the
     rating breakdown on top and `[ Approve ]` / `[ Discard ]` buttons.
- **`feedback on post draft: {text}`**: revises the most recent pending draft
  using `{text}` as the edit instruction, and sends the new version with the
  same buttons.
- **Approve / Discard buttons**: mark the draft in Supabase. Nothing is ever
  auto-posted to LinkedIn — that stays a manual, human step.
- Only responds to one Telegram user ID (yours) — every other sender is
  ignored.

Note on the research step: Google News RSS is free and needs no API key, but
its snippets are thin (often just the headline) — good enough to judge
recency/relevance, thinner than a paid news API would give you for deep
grounding.

## How it runs

Two entrypoints share the same bot logic in `src/`:

- **`src/index.js`** — long polling, for local testing (`npm start`). Telegram
  must have **no webhook registered** while you use this (see step 6).
- **`api/webhook.js`** — a Vercel serverless function. Telegram POSTs each
  update here once you register the webhook (step 7). This is what actually
  runs in production.

You can't run both against the same bot token at once — polling and a
registered webhook conflict. Switch between them with `npm run webhook:delete`
(back to local polling) and `npm run webhook:set -- <url>` (back to
production).

## Setup

### 1. Create the Telegram bot
1. Open Telegram, message **@BotFather**, send `/newbot`, follow the prompts.
2. Copy the token it gives you → `TELEGRAM_BOT_TOKEN` in `.env`.

### 2. Get your own Telegram user ID
1. Message **@userinfobot** on Telegram.
2. It replies with your numeric ID → `ALLOWED_TELEGRAM_USER_ID` in `.env`.
   This is what keeps the bot private to you.

### 3. Get a Gemini API key
One key powers everything: angle extraction, the 1-10 rating, and
drafting/revision. (News research itself uses free Google News RSS — no key.)
1. https://aistudio.google.com/apikey → create a key → `GEMINI_API_KEY` in `.env`.
2. `GEMINI_MODEL` defaults to `gemini-2.5-flash` — check
   https://aistudio.google.com/ for the current model list before relying on
   this default, model names get retired/renamed over time.

### 4. Set up Supabase (persistence)
Local disk doesn't survive Vercel's serverless cold starts, so state lives in
Supabase (Postgres over REST — no connection-pooling issues from serverless,
unlike a raw Postgres driver).
1. Create a project at https://supabase.com if you don't have one.
2. Project Settings → API → copy the **Project URL** and the **service_role**
   key (not `anon`/public — this is server-side only, never sent to a browser)
   → `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` in `.env`.
3. Supabase dashboard → SQL Editor → paste in [`supabase_schema.sql`](supabase_schema.sql)
   → run it once. This creates the `meera_notes` and `meera_drafts` tables
   (prefixed so they won't collide with anything else in the same project).

### 5. Install
```bash
npm install
cp .env.example .env
# fill in .env with the values from steps 1-4
```

### 6. Test locally (long polling)
```bash
npm start
```
Message your bot in Telegram and confirm you get a backlog reply or a draft
with buttons (see the test checklist in an earlier session, or just try a
note with a concrete number/claim in it). Ctrl+C to stop when done.

### 7. Deploy to Vercel
1. Push this repo to GitHub (see below).
2. In Vercel: **New Project** → import that repo → Framework Preset **Other**
   → Deploy. No build command needed; `api/webhook.js` is auto-detected as a
   serverless function.
3. Project Settings → Environment Variables → add all 5: `TELEGRAM_BOT_TOKEN`,
   `ALLOWED_TELEGRAM_USER_ID`, `GEMINI_API_KEY`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`. Redeploy after adding them if the first
   deploy already ran.
4. Copy the deployment URL Vercel gives you, e.g. `https://your-app.vercel.app`.

### 8. The handshake — register the webhook with Telegram
```bash
npm run webhook:set -- https://your-app.vercel.app/api/webhook
```
This calls Telegram's `setWebhook` API. Verify it took effect:
```bash
npm run webhook:info
```
`url` in the response should match what you just set, and `last_error_message`
should be empty. Message your bot again — it's now running fully on Vercel.

## Project layout

```
src/
  config.js   env var loading
  db.js       Supabase persistence (meera_notes, meera_drafts, versions, status, rating)
  voice.js    loads meera_voice.txt
  llm.js      Gemini calls: extract angle, rate 1-10, draft/revise
  news.js     Google News RSS research (free, no key)
  bot.js      Telegram routing, access control, inline buttons — shared by both entrypoints below
  index.js    local entrypoint (long polling)
api/
  webhook.js  Vercel serverless entrypoint (production, webhook mode)
scripts/
  webhook.js  set/delete/info the Telegram webhook registration
supabase_schema.sql  run once in the Supabase SQL Editor before first use
vercel.json   raises the webhook function's timeout to 60s for slower Gemini calls
```

## Known v1 limitations (see the automation brief, Check 8 and Check 9)

- No feedback loop yet: approve/discard/feedback events are logged to
  Supabase but nothing currently learns from them.
- No LinkedIn API integration on purpose — posting stays manual. Don't add
  auto-posting or auto-scheduling without deciding that's actually wanted,
  not just technically easy (Check 9, "the whole thing" risk).
- `vercel.json` sets a 60s function timeout — verify your Vercel plan actually
  allows that (limits have changed over time); if the gatekeeper + search +
  draft chain runs long, this is the first thing to check.

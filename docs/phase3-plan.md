# Phase 3 plan: change topics from the app

**Status:** planned, not started. Decisions made on 18 November 2026; build it when there's time.

Today, changing the feed's topic means editing several rows of the Settings tab by hand and
waiting for the next daily run. Phase 3 adds a settings screen to the swipe app: you pick or
describe a topic on your phone, and the feed follows within minutes.

First topic to try it with: **SQL window functions and CTEs**.

## Decisions

| Question | Decision |
|---|---|
| How does the feed update after a change? | The app starts the GitHub pipeline right away (`workflow_dispatch`). Needs a fine-grained GitHub token: this repository only, permission **Actions: Read and write**, stored in Script Properties through the sheet menu, never sent to the page. |
| How is the screen protected? | A PIN, set from the sheet menu and stored as a salted SHA-256 hash in Script Properties. Every settings call checks it; 5 wrong tries lock the screen for 15 minutes. |
| One topic or many? | Saved topics, switched with one tap. Each keeps its own search phrases, rules and filters; its videos and scores stay in BigQuery when you switch away. |
| AI help? | Gemini turns a description ("SQL window functions and CTEs for data engineering interviews") into a topic, search phrases and scoring rules. You see and edit them before anything is saved. |

## Design

**Topics tab** (new, in the FocusFeed sheet): one row per saved topic.

`TOPIC | SEARCH_TERMS | SCORING_GUIDANCE | MAX_VIDEO_AGE_DAYS | LANGUAGE_FILTER | MIN_SCORE | description | last_used_at | last_version`

- Setup creates it and seeds it from the current Settings, so today's topic becomes the first saved topic.
- The row of the topic you're watching always mirrors the Settings tab (Settings stays the single source the pipeline reads; Python needs no change).
- Global settings (searches per day, Gemini models, storage, `EXCLUDE_ADS`, `PIPELINE`) stay in Settings only.

**Switching a topic** (`applyTopic`):

1. Copy the topic's row into the Settings tab, after the same validation Setup uses.
2. Pick the run: a topic used before under the same scoring rules (`last_version` equals the new `promptVersion_`) only needs **build**, which takes under a minute and uses no YouTube quota. A new topic, or changed rules, needs **daily** (collect, score, build).
3. Start it: `POST /repos/{owner}/{repo}/actions/workflows/pipeline.yml/dispatches` with `{"ref": "main", "inputs": {"command": "daily" | "build"}}`. With `PIPELINE = apps_script` instead, create one-off Apps Script triggers (collect after 1 minute, score after 8; or a feed build after 30 seconds).
4. The page polls the run (`GET .../runs?event=workflow_dispatch`, then the run's jobs and steps) and shows Collect → Score → Build, then reloads the feed.

**Server functions** (all take `{ pin, … }` and call `checkPin_` first, because the web app has no login):
`getSettingsPage`, `suggestTopic`, `saveTopic`, `applyTopic`, `deleteTopic`, `collectNow` (refresh the current topic), `getRunStatus`.

**Sheet menu:** `Set app PIN…` and `Connect GitHub…` (asks for owner/name, then the token; checks it with a GET on the workflow before saving).

**Gemini suggestion:** one call with a JSON schema `{topic, search_terms[], guidance, max_video_age_days, language}`, falling back across `GEMINI_MODEL` and `GEMINI_FALLBACK_MODELS`. The output is cleaned before it reaches the form: at most 8 search phrases, no commas or hashtags in them, guidance under 600 characters, a valid two-letter language or none.

**Screens in the app** (a gear button in the top bar opens a full-screen panel):

- **PIN:** a number field and Unlock.
- **Topics:** the topic showing now (Edit, Get new videos now), your other topics (Show this feed, Edit) and Add a topic.
- **Add / edit:** a description box with "Suggest with Gemini", then Topic, Search phrases (one per line), Rules, Video age, Language, Minimum score. Buttons: Save and show this feed, Save for later, Delete (tap twice).
- **Progress:** the three steps with the current one highlighted, then "Show my new feed".

## Things to get right

- Flush pending app events before switching, because the server stamps each event with the current `TOPIC`.
- The feed is empty for the new topic until its first run finishes; say so on the progress screen.
- Each **daily** run uses about half of the day's 10,000 YouTube units, so warn before a second collect on the same day.
- The page's keyboard shortcuts (`j`, `k`, `l`, `d`) must ignore typing in form fields.
- Harden the existing menu functions while there: every public Apps Script function can be called through `google.script.run` from the public web app, so `runCollect`, `runScore`, `setup` and the like should refuse to run when they are called from the page rather than the menu or a trigger.

## Tests to add (`tests/gas.test.js`)

- Setup seeds the Topics tab from Settings, and re-running doesn't duplicate it.
- The PIN is stored only as a salted hash; a wrong PIN is rejected; 5 wrong tries lock the screen.
- Invalid topic fields are rejected and nothing is written.
- Switching to a new topic writes Settings and dispatches `daily`; switching back to an unchanged topic dispatches `build`; the token never appears in what the page receives.
- With `PIPELINE = apps_script`, switching creates the one-off triggers instead.
- The Gemini suggestion is requested with a schema and cleaned before it is returned.
- Run status maps GitHub's run and step states to Collect / Score / Build.
- `onOpen` shows the two new menu items.

## Out of scope

One shared app for many users (accounts, a user ID on every event, collection grouped by topic, YouTube quota per user). Phase 3 is still one person's copy.

# Phase 2 setup (one time, about 20 minutes)

Phase 2 runs collect → score → dbt from **GitHub Actions** instead of Apps Script. These steps give it a
BigQuery project with billing, a service account it can act as **without any key file** (Workload Identity
Federation), and the two API keys it needs. Everything stays inside Google's free tiers.

Replace the two values in step 3 with yours. Everything else is copy-paste.

## 1. Enable billing and add a budget alert

The BigQuery sandbox deletes tables after 60 days and blocks DML (`MERGE`), which dbt's incremental models need.

1. [console.cloud.google.com/billing](https://console.cloud.google.com/billing) → create a billing account, or use an existing one.
   - The $300 free trial is fine, but **upgrade to a full account** when it ends, or billing switches off again.
2. **Billing → My projects** → your FocusFeed project → **Change billing** → pick the account.
3. **Billing → Budgets & alerts → Create budget**: amount **₹200 per month**, alerts at 50 %, 90 % and 100 %.
   - A budget only emails you; it doesn't stop anything. FocusFeed normally stays at ₹0 (BigQuery's free
     tier is 10 GB of storage and 1 TB of queries a month).

## 2. Remove the sandbox expirations

In the BigQuery console, run this. Use your project ID if you're not Sid.

```sql
ALTER SCHEMA `project-e2696a08-0f9f-4c59-ad0.focus_feed`
SET OPTIONS (default_table_expiration_days = NULL, default_partition_expiration_days = NULL);

ALTER TABLE `project-e2696a08-0f9f-4c59-ad0.focus_feed.raw_videos`    SET OPTIONS (expiration_timestamp = NULL, partition_expiration_days = NULL);
ALTER TABLE `project-e2696a08-0f9f-4c59-ad0.focus_feed.scored_videos` SET OPTIONS (expiration_timestamp = NULL, partition_expiration_days = NULL);
ALTER TABLE `project-e2696a08-0f9f-4c59-ad0.focus_feed.events`        SET OPTIONS (expiration_timestamp = NULL, partition_expiration_days = NULL);
ALTER TABLE `project-e2696a08-0f9f-4c59-ad0.focus_feed.pipeline_runs` SET OPTIONS (expiration_timestamp = NULL, partition_expiration_days = NULL);
ALTER TABLE `project-e2696a08-0f9f-4c59-ad0.focus_feed.feed`          SET OPTIONS (expiration_timestamp = NULL);
```

Then in the sheet, run **FocusFeed → Setup**. It should say **✓ No sandbox expirations: data is kept**, and the
21 Dec reminder is cancelled.

## 3. Service account and keyless GitHub sign-in

Open **Cloud Shell** (the `>_` icon at the top of the console) and paste:

```bash
PROJECT_ID=project-e2696a08-0f9f-4c59-ad0      # your project ID
REPO=siddharth200211/focus-feed                # your GitHub owner/repo

gcloud config set project "$PROJECT_ID"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
gcloud services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  bigquery.googleapis.com sheets.googleapis.com youtube.googleapis.com

# the identity the pipeline runs as: it can run BigQuery jobs and edit data, nothing else
gcloud iam service-accounts create focusfeed-pipeline --display-name="FocusFeed pipeline"
SA="focusfeed-pipeline@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SA" --role=roles/bigquery.jobUser --condition=None
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$SA" --role=roles/bigquery.dataEditor --condition=None

# trust GitHub Actions, but only workflows from this one repository
gcloud iam workload-identity-pools create github --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc focus-feed --location=global \
  --workload-identity-pool=github --display-name="focus-feed repo" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='${REPO}'"
gcloud iam service-accounts add-iam-policy-binding "$SA" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/attribute.repository/${REPO}"

echo; echo "WIF_PROVIDER    = projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github/providers/focus-feed"
echo "SERVICE_ACCOUNT = ${SA}"
```

Copy the two lines it prints at the end.

## 4. Let the pipeline read the Settings tab

Open the **FocusFeed - Data** sheet → **Share** → paste the service account email (`focusfeed-pipeline@…`) →
**Viewer** → untick "Notify" → Share. The Python jobs read the Settings tab from there, so the sheet stays the
control panel for both phases.

## 5. YouTube API key

Console → **APIs & Services → Credentials → Create credentials → API key**. Then **Edit key → API restrictions →
Restrict key → YouTube Data API v3** → Save. This project gets its own 10,000 units a day, separate from Apps Script's.

The **Gemini key** is the one you already use (in the no-billing project). You'll paste it as a secret below.

## 6. GitHub settings

Repo → **Settings → Secrets and variables → Actions**:

| Name | Type | Value |
|---|---|---|
| `GCP_PROJECT_ID` | Variable | your project ID |
| `WIF_PROVIDER` | Variable | from step 3 |
| `SERVICE_ACCOUNT` | Variable | from step 3 |
| `SHEET_ID` | Variable | the sheet's ID (the long part of its URL between `/d/` and `/edit`) |
| `BQ_DATASET` | Variable | `focus_feed_v2` while Phase 2 runs side by side; `focus_feed` after switching over |
| `YOUTUBE_API_KEY` | Secret | from step 5 |
| `GEMINI_API_KEY` | Secret | your Gemini key |

Never paste keys into chats, the sheet or code.

## 7. First run

Repo → **Actions → Pipeline → Run workflow**, pick a command, one at a time, each after the last turns green:

1. **check**: prints the topic, the BigQuery datasets the service account can see, whether both keys are set,
   whether each Gemini model name exists, and how many rows the events tab has. Fix anything marked
   MISSING or "not found" before going on.
2. **setup**: creates the `focus_feed_v2` dataset and its five tables.
3. **seed**: copies Phase 1's `raw_videos`, `scored_videos` and `events` into the new, empty tables (copy
   jobs are free). Both phases then start from the same history, so their feeds can be compared. It never
   overwrites a table that already has rows, so run it **before** the first collect.
4. **daily**: collect, score, then build: what the schedule runs every day at 14:45 IST from now on.
   **build** runs the dbt project in `dbt/`: it creates a `focus_feed_v2_staging` dataset for its
   views, then builds `dim_videos`, `fct_events`, `pipeline_daily` and the `feed` table the web app
   reads, and checks them (one row per video, scores in range, sources not stale). Any single query
   that would scan more than 1 GB is refused, so a mistake can't run up a bill.

The scoring rules come from the same Settings tab, so both phases use the same prompt version: a video
scored by Phase 1 counts as scored for Phase 2.

## 8. Compare the two phases

After a few daily runs, **Run workflow → compare** prints how far Phase 1's feed (Apps Script, in
`focus_feed`) and Phase 2's (dbt, in `focus_feed_v2`) agree, and how often the two phases gave the
same video the same score. They won't match exactly: each phase asks Gemini separately about new
videos, so a 6 in one and a 7 in the other moves a video across MIN_SCORE. When they agree well,
the web app switches to Phase 2 (steps to follow).

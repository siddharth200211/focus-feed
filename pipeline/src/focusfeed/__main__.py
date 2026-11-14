"""Command line: python -m focusfeed {check|setup|seed|collect|score|build|compare|adopt} — what GitHub Actions runs.

Environment: SHEET_ID, GCP_PROJECT_ID, BQ_DATASET (optional override), YOUTUBE_API_KEY, GEMINI_API_KEY.
Google credentials come from the environment (Workload Identity Federation in GitHub Actions,
`gcloud auth application-default login` on a laptop).
"""
from __future__ import annotations

import argparse
import json
import os
import sys

from . import config as config_mod

# Commands that write pipeline data: refused in the Apps Script's own dataset until PIPELINE = github.
WRITES = {"collect", "score", "build", "adopt"}
SCOPES = ["https://www.googleapis.com/auth/cloud-platform",
          "https://www.googleapis.com/auth/spreadsheets.readonly"]


def open_sheet() -> config_mod.SheetSource:
    import google.auth
    from google.auth.transport.requests import AuthorizedSession

    creds, _ = google.auth.default(scopes=SCOPES)
    sheet_id = os.environ.get("SHEET_ID", "").strip()
    if not sheet_id:
        sys.exit("SHEET_ID is not set.")
    return config_mod.SheetSource(sheet_id, AuthorizedSession(creds))


def make_store(cfg: dict):
    from .store import BigQueryStore

    return BigQueryStore(cfg["BQ_PROJECT_ID"], cfg["BQ_DATASET"], cfg["BQ_LOCATION"])


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="focusfeed")
    p.add_argument("command", choices=["check", "setup", "seed", "collect", "score", "build", "compare", "adopt"])
    p.add_argument("--from", dest="source", default="",
                   help="seed / compare: Phase 1's dataset (default: BQ_DATASET in the Settings tab); "
                        "adopt: Phase 2's side-by-side dataset (default: <BQ_DATASET>_v2)")
    args = p.parse_args(argv)

    sheet = open_sheet()
    raw = sheet.raw()
    cfg = config_mod.parse(raw)
    errors = config_mod.validate(cfg)
    if errors:
        sys.exit("Fix the Settings tab first: " + " ".join(errors))
    store = make_store(cfg)
    sheet_dataset = config_mod.parse(raw, env={})["BQ_DATASET"]
    if (args.command in WRITES and cfg["BQ_DATASET"] == sheet_dataset and cfg["PIPELINE"] != "github"):
        sys.exit(f"{sheet_dataset} is the dataset the Apps Script writes to, and PIPELINE in Settings is still "
                 f"{cfg['PIPELINE']}. Set PIPELINE to github and run FocusFeed → Setup first, so the two phases "
                 "don't both collect and score into it (docs/phase2-setup.md, step 9).")

    if args.command == "check":
        from .gemini import Gemini
        from .rules import prompt_version

        print(json.dumps({"topic": cfg["TOPIC"], "project": cfg["BQ_PROJECT_ID"], "dataset": cfg["BQ_DATASET"],
                          "pipeline": cfg["PIPELINE"], "prompt_version": prompt_version(cfg),
                          "searches_per_day": cfg["SEARCHES_PER_DAY"]}, indent=1))
        if cfg["BQ_DATASET"] != sheet_dataset:
            print(f"Mode: side by side with the Apps Script, which uses {sheet_dataset}")
        elif cfg["PIPELINE"] == "github":
            print("Mode: this pipeline runs FocusFeed (PIPELINE = github)")
        else:
            print(f"Mode: blocked - {sheet_dataset} is the Apps Script's; set PIPELINE to github and run Setup")
        print("BigQuery datasets visible:", [d.dataset_id for d in store.client.list_datasets()])
        print("YouTube key:", "set" if os.environ.get("YOUTUBE_API_KEY") else "MISSING")
        gemini = Gemini(os.environ.get("GEMINI_API_KEY", ""))
        for m in [cfg["GEMINI_MODEL"], *cfg["GEMINI_FALLBACK_MODELS"]]:
            if m.lower() != "none":
                print(f"Gemini {m}: {gemini.model_status(m)}")
        try:
            print("events tab rows:", len(sheet.table("events")))
        except Exception as e:  # noqa: BLE001 - only the taste needs it
            print("events tab: can't read it, scoring will run without your likes:", e)
        return 0
    if args.command == "setup":
        print("\n".join(store.ensure()) or "Everything already exists.")
        return 0
    phase1_dataset = args.source or sheet_dataset
    if args.command == "seed":
        store.ensure()
        print("\n".join(store.seed_from(phase1_dataset)))
        return 0
    if args.command == "collect":
        from .collect import collect
        from .youtube import YouTube

        store.ensure()
        s = collect(cfg, store, YouTube(os.environ.get("YOUTUBE_API_KEY", "")))
        print(f"{s['searches']} searches → {s['unique']} unique videos ({s['embeddable_shorts']} embeddable ≤ 3 min); "
              f"{s['run']['rows_out']} rows → {cfg['BQ_DATASET']}.raw_videos; {s['run']['quota_units']} YouTube units")
        for n in s["notes"]:
            print("note:", n)
        return 0
    if args.command == "score":
        from .gemini import Gemini
        from .score import score, summary

        store.ensure()
        s = score(cfg, store, Gemini(os.environ.get("GEMINI_API_KEY", "")), events=lambda: sheet.table("events"))
        print("\n".join(summary(s)))
        return 0
    if args.command == "build":
        from .build import build, summary as build_summary

        store.ensure()
        out = build(cfg, store)
        print("\n".join(build_summary(out, cfg)))
        return 1 if out["run"]["status"] == "error" else 0
    if args.command == "adopt":
        store.ensure()
        print("\n".join(store.adopt_from(args.source or f"{cfg['BQ_DATASET']}_v2")))
        return 0
    if args.command == "compare":
        from .compare import compare

        print("\n".join(compare(cfg, store, phase1_dataset)))
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())

---
id: proposal-00015
title: Filter automated bot notifications from Gmail scout
status: proposed
created: 2026-04-17
source: review-franklin
---

## Problem

Over the last 7 days, 70% of Gmail scout signals were automated notifications (GitHub Actions, CodeQL, SonarQube, Datadog digests). Of 415 Gmail signals, only 60 were surfaced (14.5%). The brain already filters most bot noise, but processing 355 throwaway signals wastes scout and brain cycles.

## Solution

Add a configurable sender exclusion list to the Gmail scout. Emails matching excluded senders are dropped at collection time, never entering the signal pipeline.

Default exclusions: `notifications@github.com`, `noreply@github.com`, `datadog@dtdg.co`, `noreply@sonarqube.com`, `*@dependabot.com`.

Allow override via `state/settings.json` under `gmail_scout.excluded_senders`.

## Changes Required

| File | Change |
|------|--------|
| src/scouts/gmail.ts | Add sender exclusion filter before signal emission |
| state/settings.json | Add `gmail_scout.excluded_senders` array |

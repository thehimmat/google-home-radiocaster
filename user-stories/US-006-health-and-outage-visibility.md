---
id: US-006
title: Health and outage visibility
status: delivered
created: 2026-07-22
updated: 2026-07-22
linked_issues: []
linked_tests: []
supersedes: null
superseded_by: null
---

## Story

As the operator, I want a `/health` endpoint distinguishing upstream-source outages from relay failures, so I can tell whose fault a silent stream is.

## Acceptance criteria

- A `/health` endpoint distinguishes upstream-source outages from relay failures.

## Evidence

- `/health`
- FFmpeg watchdog `5cad7bf`

---
id: US-003
title: Reliable streaming relay for Cast-incompatible sources
status: delivered
created: 2026-07-22
updated: 2026-07-22
linked_issues: [3]
linked_tests: []
supersedes: null
superseded_by: null
---

## Story

As the owner, I want a relay that transcodes/re-serves problem streams (bad ports, TLS mismatch, Shoutcast, AAC+), so stations the Nest Hub would reject play reliably.

## Acceptance criteria

- A relay transcodes/re-serves problem streams (bad ports, TLS mismatch, Shoutcast, AAC+) so Cast-incompatible stations play reliably.

## Evidence

- `streaming-server/src/server.ts`
- `fly.toml`

## Notes

- Related: #3 (stale Railway to Fly docs).

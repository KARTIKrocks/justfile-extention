---
description: Verify a claim about just's behaviour against the installed CLI
argument-hint: <the claim to verify, e.g. "--fmt requires --unstable">
allowed-tools: Bash, Read, WebFetch
---

Verify this claim about `just` before it goes into code, docs, or the PRD:

**$ARGUMENTS**

Do not answer from memory or from documentation alone — `just`'s docs lag its releases.

1. Construct the smallest Justfile that exercises the claim, in the scratchpad directory.
2. Run it against `~/.local/bin/just` (1.58.0). Paste the actual output, including exit code.
3. Run it against `/usr/bin/just` (1.21.0) as well. A behavioural difference between the two
   is a version-gating requirement, not a curiosity — report it as one.
4. If the versions differ, find the release that changed it. Check the CHANGELOG at
   https://github.com/casey/just/blob/master/CHANGELOG.md and name the version.

Report: **confirmed / refuted / version-dependent**, the transcript that shows it, and — if
version-dependent — the minimum version required and whether it is above our 1.27.0 floor.

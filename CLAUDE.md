# CLAUDE.md

@AGENTS.md

The invariants in `AGENTS.md` govern this repository. What follows is Claude Code specific.

## Working here

* `PRD.md` is gitignored and local-only. Read it for context; never commit it, never push it,
  and never paste large sections of it into commit messages or PR descriptions.
* Before claiming anything about `just`'s behaviour, run the CLI. `~/.local/bin/just` is
  1.58.0; `/usr/bin/just` is 1.21.0 and is there on purpose for version-gating tests.
* When our parser disagrees with `just --dump`, fix the parser. `just` is the oracle.
* Don't add runtime dependencies. Activation cost is a CI-enforced budget, not a preference.
* Never commit or push to `main`. Every change is a branch plus a pull request, including
  docs and one-line fixes.

## Slash commands

* `/difftest` — run the differential suite and triage failures.
* `/verify-just` — check a claim about `just` against the installed CLI before it goes into
  code, docs, or the PRD.

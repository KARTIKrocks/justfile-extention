# Contributing

## Getting set up

You need Node 24 (the current LTS), and `just` 1.27.0 or later on your `PATH` (1.58+ recommended — some tests
exercise recent features).

```
npm ci
just check
```

`just --list` shows everything you can run.

## Branching and commits

**Every change goes through a pull request** — branch off `main`, push the branch, open a PR.
Never commit or push to `main` directly, not even for docs or a one-line fix. Branch names
follow the commit type: `feat/...`, `fix/...`, `chore/...`, `docs/...`.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(parser): support variadic parameter defaults
fix(cli): pass --justfile on every invocation
docs(readme): correct the minimum just version
```

Types in use: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `build`, `ci`, `chore`.
Scopes follow the source layout: `parser`, `cli`, `providers`, `execution`, `explorer`.

A breaking change gets a `!` after the type and a `BREAKING CHANGE:` footer. Release versions
are derived from commit history, so the type you pick determines the next version number.

## Pull requests

Small and single-purpose. A PR that changes what the parser produces must show the
differential suite passing — CI enforces this, but check locally first with `just difftest`.

Every PR runs: typecheck, Biome lint and format check, unit tests, differential tests against a
matrix of `just` versions, and the bundle-size and zero-runtime-dependency checks. All of them
are required.

Note what is *not* in that list: the sub-50 ms activation budget in [AGENTS.md](AGENTS.md) is
not measured by anything yet, because doing so needs a VS Code integration harness we have not
built. A PR that slows activation will pass CI. Reviewers are the only check on it.

[Greptile](https://www.greptile.com) also reviews every PR against this repository's
architectural invariants. Its configuration lives in `.greptile/` — `config.json` holds the
structured rules, `rules.md` explains the reasoning behind them, and `files.json` points the
reviewer at the docs it needs for context. If Greptile flags an invariant violation, fix the
code. If you believe the rule itself is wrong, change it in a separate PR so the change is
visible and reviewed rather than argued away in a thread.

## The rules that are not negotiable

Read [AGENTS.md](AGENTS.md) before your first change. It documents the architectural
invariants — the Tier 1/Tier 2 boundary, trust gating, parser totality, activation budget.
Code that breaks one of those will not be merged even if it works and the tests pass.

The two that catch people out:

1. **The parser never reports a semantic error.** It may report that it could not parse
   something at all. It may not report "unknown recipe" or "undefined variable". `just` is the
   only authority on validity, and a wrong squiggle costs more trust than a missing one buys.

2. **Nothing spawns `just` in an untrusted workspace.** `just` evaluates backticks and
   `shell()` at parse time, so reading a Justfile with the CLI executes it. See
   [SECURITY.md](SECURITY.md).

## Adding parser behaviour

New syntax support needs a fixture in the differential corpus, not only a unit test. The
fixture is what proves we agree with `just` — and keeps agreeing after the next `just` release.

When our parser and `just` disagree, `just` is right. Fix the parser, not the comparison.

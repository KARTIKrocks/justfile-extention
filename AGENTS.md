# AGENTS.md

Guidance for AI coding agents working in this repository. Humans should read it too.

## What this is

A VS Code extension for [`just`](https://github.com/casey/just). Pre-1.0, no release yet.

The full requirements live in `PRD.md`, which is **deliberately gitignored** — it is a local
working document, not published. Everything an agent must not get wrong is restated here so
this file stands alone.

## Non-negotiable invariants

These are architectural, not stylistic. Code that violates one is wrong even if it works and
even if tests pass. If a task seems to require breaking one, stop and say so.

### 1. Tier 1 never emits a semantic diagnostic

The extension has two tiers:

| | Tier 1 — in-process parser | Tier 2 — the `just` CLI |
|---|---|---|
| Runs | Every keystroke | On demand, trusted workspaces only |
| Owns | Highlighting, outline, completion, navigation, folding | Diagnostics, canonical metadata, formatting |
| Budget | Sub-millisecond, zero I/O, zero subprocesses | Subprocess, cached, single-flight |

Our parser may report an *unrecoverable syntax error* — a construct it cannot turn into any
AST at all. It may never report "unknown recipe", "undefined variable", "bad attribute",
"wrong arity", or anything else requiring semantic understanding. `just` is the only authority
on whether a Justfile is valid.

The reason is asymmetric cost: a missing squiggle is invisible, but a wrong squiggle on
correct code destroys trust in every other diagnostic we emit. Reimplementing `just`'s
semantics in TypeScript guarantees divergence, and divergence surfaces as false positives.

### 2. Tier 2 never runs in an untrusted workspace

`just` evaluates backticks and `shell()` at **parse** time. `just --dump` on a hostile
Justfile executes whatever that file contains. Merely *reading* a Justfile with the CLI is
arbitrary code execution.

Therefore:

* Every subprocess spawn goes through the single trust-checked helper. Never call
  `child_process` directly from a feature module.
* A workspace-level `just.executablePath` is ignored when the workspace is untrusted — that
  setting is itself an execution vector.
* Trust is checked at call time, not cached from activation. Users can grant trust mid-session.

### 3. Verify against the real CLI; never assume

`just`'s behaviour changes between releases and its documentation lags. Before asserting what
a flag does, what JSON shape comes back, or which version introduced a feature — run it.

The differential test harness exists for exactly this: it parses fixtures with our parser and
with `just --dump --dump-format json`, and fails on any disagreement. When our parser and
`just` disagree, **`just` is right**.

### 4. The parser is total

It never throws and never returns null. Any byte sequence produces an AST, with error nodes
where recovery was needed. Every node carries a source range. Half a Justfile still gets
highlighting, outline, and completion.

### 5. Activation stays cheap

Zero runtime dependencies. Activation must not spawn a process, read a file, or block on I/O.

Two of these are machine-checked, one is not:

| Budget | How it is enforced |
|---|---|
| Bundle under 300 KB | CI — `node esbuild.mjs --production` fails over the limit |
| Zero runtime dependencies | CI — the `bundle` job fails on any entry in `dependencies` |
| Activation under 50 ms | **Review only.** Not yet measured anywhere |

Measuring activation time needs a VS Code integration harness (`@vscode/test-cli`) that does not
exist yet. Until it does, nothing will stop you from making activation slow — so treat any I/O,
subprocess, top-level `await`, or large table construction reachable from `activate()` as a
defect, even though CI stays green.

### 6. All user-facing strings go through `vscode.l10n`

From the first string, even though only English ships. Retrofitting is far more expensive.

## TypeScript

TypeScript 7 (the native compiler), strict, with `erasableSyntaxOnly`. Three consequences that
trip people up, because the compiler rejects idioms that are legal in most other codebases:

* **No `enum`, no `namespace`, no parameter properties.** `erasableSyntaxOnly` forbids any
  syntax that emits runtime code, because esbuild transpiles file-by-file without the type
  checker. Use a frozen object plus a derived union:

  ```ts
  export const TokenKind = { Colon: ":", Comma: "," } as const;
  export type TokenKind = (typeof TokenKind)[keyof typeof TokenKind];
  ```

  This is better than an enum here anyway: the values are readable in test failures and compare
  structurally against the JSON `just --dump` emits.

* **`verbatimModuleSyntax` is on.** Type-only imports need `import type`. A plain `import` of a
  type is an error, not a warning.

* **`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on.** `arr[i]` is
  `T | undefined`, and `{ x?: number }` will not accept `{ x: undefined }`. Both matter for a
  parser: indexing past the end of a token stream is the most common way a parser stops being
  total.

`tsc` never emits — esbuild owns the build, `tsc --noEmit` owns correctness.

## Tooling

Biome for both lint and format; there is no ESLint or Prettier config. Invoke it as
`@biomejs/biome` — the bare name `biome` on npm is an unrelated package.

Biome does not do type-aware linting, so rules like `no-floating-promises` do not exist here.
Un-awaited promises in the activation path are a real hazard and will not be caught for you.

## Environment

* `just` **1.58.0** at `~/.local/bin/just` — the development version.
* `just` **1.21.0** at `/usr/bin/just` (apt) — kept deliberately as an old-version test target.
  It fails hard on `[group]`, which makes it a good fixture for version-gating tests.
* Minimum `just` the extension supports: **1.27.0**. Minimum VS Code: **1.101.0** — the first
  release whose extension host runs Node 22 (Electron 35).
* `@types/node` tracks the **extension host's** Node (22), not the toolchain's. Building and
  testing on Node 24 is deliberate and unrelated. Never bump `@types/node` past the host:
  TypeScript then accepts calls the host does not have, and it fails silently at runtime
  rather than in CI. Dependabot is configured to skip its major bumps.

## Conventions

* TypeScript, strict mode. No `any` without a comment explaining why.
* Tier 1 code must not import `vscode` — the parser is a pure library, testable in plain Node
  and reusable outside the editor. Only the provider layer touches the VS Code API.
* Prefer native VS Code UI. No webviews without an explicit decision recorded in the PRD.
* Tests live beside what they test. New parser behaviour needs a fixture in the differential
  corpus, not just a unit test.

## Commands

Run these rather than inventing equivalents. `just --list` shows the rest.

```
just build        # esbuild bundle into dist/
just check        # typecheck + lint + unit tests (the pre-commit gate)
just test         # everything, including the differential suite
just difftest     # differential tests only, against the just CLI
```

## Pull requests

**Every change goes through a pull request. Never commit to `main`, and never push to `main`
directly** — branch, push the branch, open a PR, let CI and review run. This holds for one-line
fixes and for docs.

Branch names follow the commit type: `feat/...`, `fix/...`, `chore/...`, `docs/...`.

Keep PRs small and single-purpose. A PR that changes parser output must show the differential
suite passing and must add or update a fixture.

Greptile reviews every PR against the invariants above; its configuration lives in `.greptile/`.
If it flags an invariant violation, fix the code — do not argue the rule away in a comment. If
the rule itself is wrong, change `.greptile/config.json` in a separate PR so the change is
visible and reviewed.

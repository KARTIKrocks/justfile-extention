# Justfile Tools for VS Code

A VS Code extension for [`just`](https://github.com/casey/just), the command runner.

> **Status: pre-release.** Language support and recipe running are built and tested — syntax
> highlighting, semantic tokens, the document outline, folding, CLI detection with a status bar,
> and a **Run** button above every recipe. Completion, hover, diagnostics and the rest of the
> product are not yet built. Install the pre-release channel to follow along; stable releases
> start with the MVP.

## Install

From the Extensions view, search for **Justfile Tools** and choose **Install Pre-Release Version**.
The extension is published to the
[Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=KartikRajput.just-lang).
It is not on Open VSX yet, so VSCodium and other editors that use that registry cannot install
it from their Extensions view for now.

Or from the command line:

```
code --install-extension KartikRajput.just-lang --pre-release
```

## What works today

* Syntax highlighting for `justfile`, `Justfile`, `.justfile` and `*.just`
* Semantic tokens on top of the grammar, from an error-tolerant parser — half a Justfile still
  highlights
* Document outline, with recipes gathered under their `[group]`s
* Folding for recipe bodies, multi-line expressions and comment blocks
* Status bar showing the detected `just` version, with commands to check the installation and
  point the extension at a different executable
* **▶ Run** above every recipe, and **Run with Arguments…** when it has parameters. Runs
  `just <recipe>` as a task in the integrated terminal, asking for required parameters first.
  Also `Just: Run Recipe` in the Command Palette.

Only the last two run `just` — and both wait for Workspace Trust. Everything else is served by
the in-process parser and works in untrusted workspaces and without `just` installed.

## Design

The full product requirements document is a local working file and is not published. The short
version:

**Two tiers, with a hard boundary.**

| | Tier 1 — in-process parser | Tier 2 — `just` CLI |
|---|---|---|
| Runs | Every keystroke | On demand, trusted workspaces only |
| Provides | Highlighting, semantic tokens, outline, folding, completion, navigation | Diagnostics, canonical metadata, formatting |
| Cost | Sub-millisecond, zero I/O, zero subprocesses | Subprocess, cached, single-flight |

Two rules follow from that split, and the rest of the design is downstream of them:

1. **Tier 1 never emits a semantic diagnostic.** `just` is the only authority on whether a Justfile is valid. A wrong squiggle is worse than no squiggle.
2. **Tier 2 never runs in an untrusted workspace.** `just` evaluates backticks and `shell()` at *parse* time, so merely reading a Justfile with the CLI executes whatever it contains. See [SECURITY.md](SECURITY.md).

## Requirements

* VS Code 1.101.0 or later
* `just` 1.27.0 or later, for the status bar and for the Tier 2 features still to come

Everything Tier 1 provides works without `just` installed at all, and in untrusted workspaces.

## Development

```
npm ci
just check
```

`just --list` shows every command. See [CONTRIBUTING.md](CONTRIBUTING.md) for the branching,
commit and PR conventions, [AGENTS.md](AGENTS.md) for the architectural invariants the codebase
is built around, and [RELEASING.md](RELEASING.md) for how a version gets to the Marketplace.

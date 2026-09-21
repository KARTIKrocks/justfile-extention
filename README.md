# Justfile for VS Code

A VS Code extension for [`just`](https://github.com/casey/just), the command runner.

> **Status: pre-release.** Language support is built and tested — syntax highlighting, semantic
> tokens, the document outline, folding, and CLI detection with a status bar. Recipe execution,
> completion, hover, diagnostics and the rest of the product are not yet built. See the
> development order in the design notes for what's next.

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
commit and PR conventions, and [AGENTS.md](AGENTS.md) for the architectural invariants the
codebase is built around.

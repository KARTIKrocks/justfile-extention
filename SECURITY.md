# Security Policy

## Reporting a vulnerability

Please report security issues privately via GitHub's
[private vulnerability reporting](https://github.com/KARTIKrocks/justfile/security/advisories/new)
rather than opening a public issue. You should get an acknowledgement within 72 hours.

## Threat model

This extension has an unusually sharp security boundary for an editor plugin, and it is worth
stating plainly.

**`just` executes code at parse time.** Backticks and the `shell()` function are evaluated when
a Justfile is *read*, not when a recipe is *run*. That means `just --dump` on a Justfile — an
operation that looks like nothing more than fetching metadata — runs whatever commands that
file contains.

Consequently, opening an untrusted repository must never cause the extension to invoke the
`just` binary. The extension is built around this:

* Every feature that needs the CLI is gated on VS Code Workspace Trust.
* In an untrusted workspace the extension falls back to its in-process parser, which never
  spawns a process and never evaluates anything.
* A workspace-scoped `just.executablePath` setting is ignored when the workspace is untrusted,
  because that setting is itself a way to specify an arbitrary binary to execute.

Reports that demonstrate a path around any of the above are treated as high severity.

## Scope

In scope: sandbox escapes from untrusted workspaces, command injection through Justfile
content or settings, and unintended execution of workspace-controlled binaries.

Out of scope: a trusted workspace running a recipe that does something destructive. Running
recipes is the point of the extension, and trust is the boundary.

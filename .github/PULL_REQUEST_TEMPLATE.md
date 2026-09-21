## What and why

<!-- What changes, and what problem it solves. Link the issue if there is one. -->

Closes #

## Invariant checklist

<!-- Delete any line that is genuinely not applicable to this PR, rather than ticking it blindly. -->

- [ ] No semantic diagnostic is emitted from Tier 1 (the parser reports only unrecoverable syntax errors)
- [ ] Any new process spawn goes through the trust-checked helper, not `child_process` directly
- [ ] The parser still cannot throw or return null for any input
- [ ] No new runtime dependency, and activation still does no I/O
- [ ] New user-facing strings go through `vscode.l10n`

## Testing

<!-- What you ran, and what a reviewer should run. Parser changes need a differential fixture. -->

- [ ] `just check` passes
- [ ] `just difftest` passes
- [ ] Added a differential fixture (required if parser output changed)

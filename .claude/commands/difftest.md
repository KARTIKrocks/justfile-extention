---
description: Run the differential test suite against the just CLI and triage failures
allowed-tools: Bash, Read, Edit, Grep, Glob
---

Run the differential suite: `just difftest`

The suite parses every fixture with our parser and with `just --dump --dump-format json`,
then compares the resulting models. Any disagreement is a failure.

If it passes, say so and stop.

If it fails, for each failing fixture:

1. Show the fixture source, our parse output, and `just`'s output side by side.
2. Classify the disagreement:
   * **Our parser is wrong** — the default assumption. `just` is the oracle. Fix the parser.
   * **The comparison is wrong** — we are comparing a field `just` does not actually promise,
     or normalising incorrectly. Fix the harness, and say clearly why the field is not
     comparable.
   * **A genuine `just` bug** — extraordinary. Requires a reproduction against the real CLI
     pasted into the report before you claim it.
3. Fix, then re-run the full suite.

Never make a test pass by loosening the comparison unless you have justified case 2 above.
Never skip a fixture to get green.

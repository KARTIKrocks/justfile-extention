---
name: add-syntax-support
description: Add parser support for a just language construct - a new attribute, setting, expression form, or recipe syntax. Use when teaching the Tier 1 parser to understand something it currently does not, or when a just release adds syntax we do not handle.
---

# Adding support for a just construct

The hazard this procedure exists to prevent is a **partial** implementation: syntax that lexes
but does not parse, parses but is dropped from the semantic model, or is modelled differently
from how `just` models it. Each of those is invisible until a user hits it, and the last one is
the worst, because it makes the differential suite the only thing standing between us and a
wrong diagnostic.

Do all six steps. Stop and report if any one of them cannot be completed.

## 1. Establish ground truth first

Before writing any code, find out what `just` actually does. Do not work from documentation or
memory — `just`'s docs lag its releases.

Write the smallest Justfile exercising the construct into the scratchpad, then:

```
just -f <file> --dump --dump-format json
just -f <file> --dump --dump-format just
just -f <file> --evaluate
```

The JSON is the contract. Our semantic model mirrors its shape, so read it before deciding on
field names or types.

Then find the minimum `just` version. Run the same file against `/usr/bin/just` (1.21.0), and
if it differs, bisect using the upstream CHANGELOG. If the construct requires a version above
our 1.27.0 floor, it needs version gating, and completion must not offer it on older binaries.

## 2. Lexer

`src/parser/lexer.ts`. Add token kinds to `src/parser/token.ts` as entries in the `TokenKind`
object — not an enum; see AGENTS.md.

The lexer must stay total. New scanning code cannot throw and cannot loop forever on malformed
input. If a delimiter is unterminated, emit the token with `unterminated: true` and carry on to
end of file.

## 3. AST

`src/parser/ast.ts`. Every node carries a `Span`. Nodes are readonly.

A construct that can appear malformed needs an error-tolerant shape — usually an optional field
rather than a required one, so a half-typed construct still produces a node with a range rather
than nothing.

## 4. Parser

`src/parser/parser.ts`. The parser never throws and never returns null.

When input does not match, recover: consume to the next synchronisation point (newline, or
dedent out of a recipe body), attach an error node, and continue. Test the half-typed case
explicitly — someone typing this construct one character at a time must still get an outline.

## 5. Semantic model

`src/model/`. Mirror the field names and types from the `--dump` JSON you captured in step 1.
Where we deliberately differ, say why in a comment.

## 6. Differential fixture

Add the fixture to `test/differential/fixtures/`, named for the construct. This is the step
people skip, and it is the one that matters: the fixture is what proves we agree with `just`
today and keeps proving it after the next `just` release.

Then run `just difftest`. When our parser and `just` disagree, `just` is right — fix the
parser, never the comparison.

## Report

State which `just` version introduced the construct, whether it needs version gating, and paste
the `difftest` result. If you added a token kind or AST node without a fixture, say so plainly
rather than letting it pass as complete.

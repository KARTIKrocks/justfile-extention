# List literals: `["a", "b"]`, the value form the string-list settings take.
#
# `just` parses a bracket group as an expression everywhere an expression is
# allowed and only rejects it later — outside `shell`, `windows-shell` and
# `script-interpreter` a list needs the unstable `set lists`, added in 1.53.0.
# That gate is semantic and therefore Tier 2's to enforce, so the parser never
# mentions it. `script-interpreter` is left out of this fixture on purpose: it
# arrived in 1.33.0, and gating the whole file on that would stop it running
# against the oldest binaries in the matrix, which is where a list is most
# likely to be mishandled.
#
# Unusually for this corpus, the comparison here reaches inside the value.
# `just` reports `shell` as `{command, arguments}`, and a list of string
# literals needs no evaluation to read, so `Comparable.stringLists` compares the
# elements themselves. That is what makes this fixture worth having: dropping an
# element, mis-reading a comma on its own line, running past the `]`, or not
# parsing lists at all each fail here rather than only in a unit test.
#
# Spans are still outside its reach — the dump carries none — so the ranges
# these items produce are pinned by src/parser/parser.test.ts instead.

set shell := ["bash", "-cu"]

set windows-shell := [
    "pwsh.exe"
    ,
    "-NoLogo",
    "-Command",
]

version := "1.0"

alias b := build

build target="release": deps
    echo "building {{ target }}"

deps:
    echo deps

test: build && report
    echo test

report:
    echo report

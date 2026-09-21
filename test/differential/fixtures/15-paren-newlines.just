# Newlines inside `(...)` and a call's arguments — `just` treats them as
# insignificant there, the same tolerance list literals have inside `[...]`
# (see 13-lists.just), and for the same reason: a value like this is written
# split across lines far more often than the single-line forms 12-expressions
# already covers.
#
# What this proves, and what it does not, matches that fixture exactly: the
# comparison covers item structure only, never expression content — `just
# --dump` emits no spans and no unevaluated values, so shattering every one of
# these into an error node would still leave this suite green if the item
# count and shape happened to survive. What genuine coverage this buys is real
# though: an unclosed `(` is exactly as dangerous as an unclosed `[` (nothing
# stops the scan until `atItemStart` bounds it), and if that bound regressed,
# the recipes and the alias below would vanish or merge into error-items,
# which the item-structure comparison does catch. Content-level correctness —
# that the split value actually is "a" and not "a" plus a dropped operand —
# is pinned by src/parser/parser.test.ts, because nothing else can pin it.

grouped := (
    "a"
)

concatenated := (
    "a" +
    "b"
)

concatenated_leading_newline := (
    "a"
    + "b"
)

joined := (
    "a" /
    "b"
)

absolute_join := (
    / "a"
)

called := lowercase(
    "MiXeD",
)

call_trailing_comma_own_line := replace(
    "a-b-c",
    "-",
    "_"
    ,
)

nested_call_in_group := (
    uppercase(
        "x"
    ) + "y"
)

alias g := build

# A parameter default's colon terminates the header, so it always comes
# *after* the default — unlike a dependency's parens, which sit right after
# the header's own colon. That ordering is why this is safe to split across
# lines and a multi-line `use: (build (...))`-style dependency is not: the
# lexer decides whether the next indented line opens the recipe body from
# whether it has already seen that colon, one physical line at a time, with
# no notion of "still inside an open paren". A dependency's colon precedes
# its parens, so a multi-line one is misread as the start of the body before
# the parser ever runs — a lexer-level gap, not a parser one, and separate
# from what this fixture covers.
build target=(
    uppercase("release")
):
    echo {{ target }}

use: (build ("d" + "ebug"))
    echo used

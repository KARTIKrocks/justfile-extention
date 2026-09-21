# Expression forms the parser spans separately: parenthesised groups, calls,
# joins, concatenations and conditionals.
#
# Be clear about what this does and does not prove. The comparison covers item
# structure — names, parameters, dependency counts, attributes — and `just
# --dump` emits no spans at all, so ranges cannot be compared here. Nor can
# expression content: replacing every parenthesised group with an error node
# leaves this suite entirely green, and only the unit tests in
# src/parser/parser.test.ts notice.
#
# What it does buy is real: these forms now go through the parser on every run,
# the truncation check covers them, and the items they belong to are compared
# against just. Span and expression behaviour is pinned by unit tests, because
# nothing else can pin it.

grouped := ("a" + "b")
nested := (("x"))
joined := ("a" / "b") / "c"
called := lowercase("MiXeD")
call_in_group := (uppercase("x") + "y")
conditional := if "a" == "a" { "yes" } else { "no" }
export exported_group := ("e" + "f")

build target=(uppercase("release")):
    echo {{ (target + "!") }}

use: (build ("d" + "ebug"))
    echo used

# requires: 1.31.0
#
# `mod?` is the form that catches a parser out. The `?` needs no space around
# it, because it cannot appear in a name, so `mod?maybe` is one declaration and
# not a recipe called "mod" — reading only the token after `mod` gets this
# wrong and loses the module entirely.

mod greet "mods/greet.just"
mod? maybe "mods/greet.just"
mod?terse "mods/greet.just"

build:
    echo build

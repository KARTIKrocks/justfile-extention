# requires: 1.27.0

[private]
_hidden:
    echo hidden

[group('build')]
compile:
    echo compile

[group('build')]
[no-cd]
link:
    echo link

# `set`, `alias`, `import` and `mod` are not reserved words.
#
# Each is a perfectly good recipe name, so the shape of the line has to decide
# what it is and not the word it starts with. `import:` is a recipe; `mod p:` is
# a recipe named "mod" that takes a parameter, not a module named "p".
#
# Every name here is compared against `just`, so reading one of these lines as
# the wrong kind of item fails: the recipe goes missing, and for `mod` a module
# appears that the file never declared.

import:
    echo import

mod p:
    echo mod {{ p }}

set q="x":
    echo set {{ q }}

alias r: import
    echo alias

@export:
    echo export

unexport:
    echo unexport

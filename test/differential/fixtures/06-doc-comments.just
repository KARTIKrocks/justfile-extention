# Build the project
build:
    echo build

# First line
# Second line
multi:
    echo multi

no-doc:
    echo none

#    leading and trailing whitespace are trimmed   
padded:
    echo padded

## a second hash is part of the text
double-hash:
    echo double

# a blank comment line last means no doc, even under a real one
#
blank-last:
    echo blank

#
# the last line still wins after a blank one
blank-first:
    echo first

#   
whitespace-only:
    echo ws

first:
    echo first

second:
    echo second

with-args target:
    echo {{target}}

all: first second && cleanup
    echo all

parameterised: (with-args "value")
    echo done

cleanup:
    echo cleanup

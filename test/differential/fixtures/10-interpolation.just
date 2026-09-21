name := "world"

greet target=name:
    echo "hello {{target}}"
    echo "{{ uppercase(target) }}"
    echo "nested {{ if target == "world" { "earth" } else { "elsewhere" } }}"

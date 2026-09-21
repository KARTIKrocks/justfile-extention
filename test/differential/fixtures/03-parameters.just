singular a:
    echo {{a}}

with-default a="x":
    echo {{a}}

plus a +rest:
    echo {{a}} {{rest}}

star a *rest:
    echo {{a}} {{rest}}

exported $a:
    echo $a

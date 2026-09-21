/**
 * The grammar, run through the engine VS Code itself uses.
 *
 * Everything here asserts on a scope a theme actually colours. Structural tests
 * cannot tell a working grammar from one that matches nothing, so this is the
 * file that decides whether the highlighting is real.
 */

import { describe, expect, it } from "vitest";
import { scopesAt, tokenize } from "./grammar.js";

const SAMPLE = `# Build everything
set shell := ["bash", "-c"]
set dotenv-load

export VERSION := "1.0"
target_dir := justfile_directory() / "tmp"

alias b := build

import? "extra.just"
mod docs "docs/justfile"

# Compile the project
[group('build')]
[private]
@build profile="release" *flags:
    #!/usr/bin/env bash
    # not shell output
    echo "building {{ profile }}"
    cargo build \\
        --locked

test: build && report
    just --list
`;

describe("top-level items", () => {
    it("scopes a comment", async () => {
        expect(await scopesAt(SAMPLE, "# Build everything")).toContain(
            "comment.line.number-sign.just",
        );
    });

    it("scopes `set` and the setting name", async () => {
        expect(await scopesAt(SAMPLE, "set shell")).toContain("keyword.other.set.just");
        expect(await scopesAt(SAMPLE, "shell :=")).toContain("support.type.property-name.just");
    });

    it("highlights inside a setting's value", async () => {
        expect(await scopesAt(SAMPLE, '"bash"')).toContain("string.quoted.double.just");
    });

    it("scopes a setting with no value", async () => {
        expect(await scopesAt(SAMPLE, "dotenv-load")).toContain("support.type.property-name.just");
    });

    it("scopes an unexport that carries a trailing comment", async () => {
        // just accepts `unexport FOO # note`, so the rule cannot demand that the
        // name be the last thing on the line.
        const source = "unexport FOO # note\n";
        expect(await scopesAt(source, "unexport")).toContain("storage.modifier.export.just");
        expect(await scopesAt(source, "FOO")).toContain("variable.other.assignment.just");
        expect(await scopesAt(source, "# note")).toContain("comment.line.number-sign.just");
    });

    it("scopes an exported assignment", async () => {
        expect(await scopesAt(SAMPLE, "export VERSION")).toContain("storage.modifier.export.just");
        expect(await scopesAt(SAMPLE, "VERSION")).toContain("variable.other.assignment.just");
        expect(await scopesAt(SAMPLE, ':= "1.0"')).toContain("keyword.operator.assignment.just");
    });

    it("scopes a plain assignment and its expression", async () => {
        expect(await scopesAt(SAMPLE, "target_dir")).toContain("variable.other.assignment.just");
        expect(await scopesAt(SAMPLE, "justfile_directory")).toContain("support.function.just");
        expect(await scopesAt(SAMPLE, '/ "tmp"')).toContain("keyword.operator.just");
    });

    it("scopes an alias and the recipe it points at", async () => {
        expect(await scopesAt(SAMPLE, "alias")).toContain("keyword.other.alias.just");
        expect(await scopesAt(SAMPLE, "b :=")).toContain("entity.name.function.alias.just");
        expect(await scopesAt(SAMPLE, "build\n\nimport")).toContain("entity.name.function.just");
    });

    it("scopes an optional import", async () => {
        expect(await scopesAt(SAMPLE, "import")).toContain("keyword.control.import.just");
        expect(await scopesAt(SAMPLE, '? "extra')).toContain("keyword.operator.optional.just");
        expect(await scopesAt(SAMPLE, '"extra.just"')).toContain("string.quoted.double.just");
    });

    it("scopes an optional module written tight", async () => {
        // just accepts `mod?sub` with no space, though `mod sub` still needs one.
        const source = "mod?sub\n";
        expect(await scopesAt(source, "mod")).toContain("keyword.control.import.module.just");
        expect(await scopesAt(source, "?")).toContain("keyword.operator.optional.just");
        expect(await scopesAt(source, "sub")).toContain("entity.name.namespace.just");
    });

    it("scopes a module and its path", async () => {
        expect(await scopesAt(SAMPLE, "mod")).toContain("keyword.control.import.module.just");
        expect(await scopesAt(SAMPLE, "docs ")).toContain("entity.name.namespace.just");
        expect(await scopesAt(SAMPLE, '"docs/justfile"')).toContain("string.quoted.double.just");
    });
});

describe("attributes", () => {
    it("scopes the attribute name", async () => {
        expect(await scopesAt(SAMPLE, "group")).toContain("entity.other.attribute-name.just");
        expect(await scopesAt(SAMPLE, "private")).toContain("entity.other.attribute-name.just");
    });

    it("leaves a recipe's doc comment as an ordinary comment", async () => {
        // just treats the line above a recipe as its documentation, but deciding
        // that needs the following lines, and a TextMate rule only ever sees one.
        // The semantic token provider has the parser's answer; this layer does not
        // guess at it.
        const scopes = await scopesAt(SAMPLE, "# Compile the project");
        expect(scopes).toContain("comment.line.number-sign.just");
        expect(scopes.some((s) => s.includes("documentation"))).toBe(false);
    });

    it("scopes an attribute argument as a string", async () => {
        expect(await scopesAt(SAMPLE, "'build'")).toContain("string.quoted.single.just");
    });
});

describe("recipes", () => {
    it("scopes the name and the quiet marker", async () => {
        expect(await scopesAt(SAMPLE, "@build")).toContain("keyword.operator.quiet.just");
        expect(await scopesAt(SAMPLE, "build profile")).toContain("entity.name.function.just");
    });

    it("scopes parameters, defaults and variadic markers", async () => {
        expect(await scopesAt(SAMPLE, "profile=")).toContain("variable.parameter.just");
        expect(await scopesAt(SAMPLE, '"release"')).toContain("string.quoted.double.just");
        expect(await scopesAt(SAMPLE, "*flags")).toContain("keyword.operator.variadic.just");
        expect(await scopesAt(SAMPLE, "flags:")).toContain("variable.parameter.just");
    });

    it("scopes dependencies, including the ones that run after", async () => {
        expect(await scopesAt(SAMPLE, "test:")).toContain("entity.name.function.just");
        expect(await scopesAt(SAMPLE, "build &&")).toContain("entity.name.function.just");
        expect(await scopesAt(SAMPLE, "&&")).toContain("keyword.operator.logical.just");
        expect(await scopesAt(SAMPLE, "report")).toContain("entity.name.function.just");
    });

    it("scopes a shebang as the interpreter line, not as a comment body", async () => {
        expect(await scopesAt(SAMPLE, "#!/usr/bin/env")).toContain("comment.line.shebang.just");
    });

    it("scopes a whole-line comment in the body", async () => {
        expect(await scopesAt(SAMPLE, "# not shell output")).toContain(
            "comment.line.number-sign.just",
        );
    });

    it("scopes an interpolation and the variable inside it", async () => {
        expect(await scopesAt(SAMPLE, "{{ profile")).toContain(
            "punctuation.section.interpolation.begin.just",
        );
        expect(await scopesAt(SAMPLE, "profile }}")).toContain("variable.other.just");
    });

    it("scopes a trailing backslash as a continuation", async () => {
        expect(await scopesAt(SAMPLE, "\\\n        --locked")).toContain(
            "punctuation.separator.continuation.just",
        );
    });

    it("leaves the rest of a body line to the shell", async () => {
        // Guessing at shell syntax would mis-colour working recipes. Real shell
        // highlighting is an embedded-grammar job, not this one.
        const scopes = await scopesAt(SAMPLE, "cargo build");
        expect(scopes).toEqual(["source.just", "meta.recipe.just"]);
    });

    it("keeps the body inside the recipe and stops at the next item", async () => {
        const tokens = await tokenize(SAMPLE);
        const justList = tokens.find((t) => t.text.includes("--list"));
        expect(justList?.scopes).toContain("meta.recipe.just");

        const nextItem = tokens.find((t) => t.text === "test");
        expect(nextItem?.scopes).toContain("entity.name.function.just");
    });
});

describe("expressions that span lines", () => {
    // just accepts both of these. An expression that stops highlighting at the
    // first newline leaves the rest of the value looking like plain text.
    const ARRAY = 'set shell := [\n  "bash",\n  "-c"\n]\n\nfoo:\n    echo hi\n';
    const PAREN = 'x := (\n  "a"\n)\n\nfoo:\n    echo hi\n';

    it("keeps highlighting a setting's array across lines", async () => {
        expect(await scopesAt(ARRAY, '"bash"')).toContain("string.quoted.double.just");
        expect(await scopesAt(ARRAY, '"-c"')).toContain("string.quoted.double.just");
        expect(await scopesAt(ARRAY, "]")).toContain("meta.brace.square.just");
    });

    it("keeps highlighting a parenthesised assignment across lines", async () => {
        expect(await scopesAt(PAREN, '"a"')).toContain("string.quoted.double.just");
    });

    it("still ends the item, so the recipe below is still a recipe", async () => {
        for (const source of [ARRAY, PAREN]) {
            const scopes = await scopesAt(source, "foo:");
            expect(scopes).toContain("entity.name.function.just");
            expect(scopes).not.toContain("meta.setting.just");
            expect(scopes).not.toContain("meta.assignment.just");
        }
    });

    it("gives up on a group that never closes rather than eating the file", async () => {
        // One stray bracket while typing must not drag every recipe below it
        // into the expression. Every shape that starts a new item has to break
        // out, not just a parameterless recipe header, so each is checked for
        // the scope it should have recovered to.
        const next: [string, string, string][] = [
            ["build:\n    echo hi\n", "build:", "entity.name.function.just"],
            ["build target:\n    echo hi\n", "build target", "entity.name.function.just"],
            [
                "[private]\nfoo:\n    echo hi\n",
                "[private]",
                "punctuation.definition.attribute.begin.just",
            ],
            ['export FOO := "y"\n', "export FOO", "storage.modifier.export.just"],
            ["unexport FOO\n", "unexport FOO", "storage.modifier.export.just"],
            ["alias b := foo\n", "alias b", "keyword.other.alias.just"],
            ['import "a.just"\n', "import ", "keyword.control.import.just"],
            ['import? "a.just"\n', "import?", "keyword.control.import.just"],
            ["mod sub\n", "mod sub", "keyword.control.import.module.just"],
            ["mod? sub\n", "mod? sub", "keyword.control.import.module.just"],
            ["mod?sub\n", "mod?sub", "keyword.control.import.module.just"],
            ['other := "z"\n', "other :=", "variable.other.assignment.just"],
        ];
        for (const opener of ["x := foo(\n\n", "set shell := [\n\n"]) {
            for (const [tail, needle, expected] of next) {
                const where = `${JSON.stringify(needle)} after ${JSON.stringify(opener.trim())}`;
                expect(await scopesAt(opener + tail, needle), where).toContain(expected);
            }
        }
    });

    it("lets a double-quoted string run on, because just does too", async () => {
        // `a := "one\ntwo"` is one assignment as far as just is concerned, so an
        // unterminated string swallowing what follows is the honest rendering.
        const source = 'x := "oops\n\nbuild:\n    echo hi\n';
        expect(await scopesAt(source, "build:")).toContain("string.quoted.double.just");
    });
});

describe("line continuation", () => {
    // `x := "a" + \` then `  "b"` dumps as `x := "a" + "b"`, so the expression
    // really does carry on. vscode-textmate appends a newline to every line
    // before matching, so an end pattern has to exclude that newline as well as
    // the backslash, or it closes the item anyway and the next line goes bare.
    const ASSIGN = 'x := "a" + \\\n  "b"\n\nfoo:\n    echo hi\n';
    const SETTING = 'set dotenv-path := "a" + \\\n  "b"\n';

    it("carries an assignment onto the continued line", async () => {
        const scopes = await scopesAt(ASSIGN, '"b"');
        expect(scopes).toContain("string.quoted.double.just");
        expect(scopes).toContain("meta.assignment.just");
    });

    it("carries a setting onto the continued line", async () => {
        const scopes = await scopesAt(SETTING, '"b"');
        expect(scopes).toContain("string.quoted.double.just");
        expect(scopes).toContain("meta.setting.just");
    });

    it("scopes the backslash itself", async () => {
        expect(await scopesAt(ASSIGN, "\\")).toContain("punctuation.separator.continuation.just");
    });

    it("still ends at the item after the continued line", async () => {
        expect(await scopesAt(ASSIGN, "foo:")).toContain("entity.name.function.just");
    });
});

describe("dependencies with arguments", () => {
    it("scopes only the head as a recipe, not its arguments", async () => {
        // Confirmed by running it: `test: (b v)` passes the variable v. Colouring
        // an argument as a recipe makes the colour useless for telling them apart.
        const source = 'v := "val"\nb arg:\n    echo hi\n\ntest: (b v)\n    echo t\n';
        expect(await scopesAt(source, "b v")).toContain("entity.name.function.just");
        const arg = await scopesAt(source, "v)");
        expect(arg).toContain("variable.other.just");
        expect(arg).not.toContain("entity.name.function.just");
    });
});

describe("settings", () => {
    it("scopes the assignment operator", async () => {
        expect(await scopesAt("set dotenv-load := true\n", ":=")).toContain(
            "keyword.operator.assignment.just",
        );
    });

    it("treats true and false as literals in a setting", async () => {
        expect(await scopesAt("set dotenv-load := true\n", "true")).toContain(
            "constant.language.boolean.just",
        );
        expect(await scopesAt("set quiet := false\n", "false")).toContain(
            "constant.language.boolean.just",
        );
    });

    it("treats true as an ordinary name everywhere else", async () => {
        // Verified against just 1.58.0: `x := true` is "variable `true` not
        // defined", and `true := "x"` is a legal assignment. There is no boolean
        // literal in the expression grammar.
        const scopes = await scopesAt("x := true\n", "true");
        expect(scopes).toContain("variable.other.just");
        expect(scopes).not.toContain("constant.language.boolean.just");
    });
});

describe("things that must not be mistaken for something else", () => {
    it("does not read an assignment as a recipe", async () => {
        expect(await scopesAt("x := y\n", "x")).toContain("variable.other.assignment.just");
        expect(await scopesAt("x := y\n", "x")).not.toContain("entity.name.function.just");
    });

    it("does not treat a `#` inside a string as a comment", async () => {
        const source = 'colour := "#ff0000"\n';
        expect(await scopesAt(source, "#ff0000")).toContain("string.quoted.double.just");
        expect(await scopesAt(source, "#ff0000")).not.toContain("comment.line.number-sign.just");
    });

    it("does treat a trailing `#` after an expression as a comment", async () => {
        const source = 'x := "a" # note\n';
        expect(await scopesAt(source, "# note")).toContain("comment.line.number-sign.just");
    });

    it("allows a recipe named after any keyword", async () => {
        // None of these are reserved: just accepts every one as a recipe name.
        // A keyword rule that does not insist on what follows it claims the name
        // instead, which is how `import:` came to read as an import.
        for (const keyword of ["set", "alias", "import", "mod", "export", "unexport"]) {
            expect(
                await scopesAt(`${keyword}:\n    echo hi\n`, keyword),
                `recipe named ${keyword}`,
            ).toContain("entity.name.function.just");
        }
    });

    it("resolves escapes only in cooked strings", async () => {
        expect(await scopesAt('a := "x\\ny"\n', "\\n")).toContain("constant.character.escape.just");
        expect(await scopesAt("a := 'x\\ny'\n", "\\n")).not.toContain(
            "constant.character.escape.just",
        );
    });

    it("leaves an unknown escape unscoped rather than marking it invalid", async () => {
        // just rejects `\\q`, but saying so is Tier 2's job. A red squiggle from
        // Tier 1 on a file just might accept is the failure mode to avoid.
        const scopes = await scopesAt('a := "x\\qy"\n', "\\q");
        expect(scopes).toContain("string.quoted.double.just");
        expect(scopes).not.toContain("constant.character.escape.just");
        expect(scopes.some((s) => s.startsWith("invalid."))).toBe(false);
    });

    it("keeps a triple-quoted string in one piece", async () => {
        const source = 'a := """\n  line one " still inside\n  """\n';
        expect(await scopesAt(source, "still inside")).toContain(
            "string.quoted.triple.double.just",
        );
    });

    it("sees a CRLF file the way VS Code presents it", async () => {
        // VS Code tokenises line content with the terminator stripped, so a
        // carriage return never reaches the grammar and no rule needs to allow
        // for one. The helper has to imitate that or it tests a different thing.
        const source = "build:\r\n    echo hi\r\n\r\ntest: build\r\n    echo t\r\n";
        expect(await scopesAt(source, "test:")).toContain("entity.name.function.just");
        const body = await tokenize(source);
        expect(body.every((t) => !t.text.includes("\r"))).toBe(true);
    });

    it("scopes a backtick command as a string, not as shell", async () => {
        expect(await scopesAt("a := `date +%s`\n", "date")).toContain(
            "string.interpolated.backtick.just",
        );
    });
});

describe("keywords are not reserved words", () => {
    // Verified against just 1.58.0: every one of these lines is a recipe. A
    // rule that matches on the first word alone claims them, and the recipe
    // then loses its name colour and its body highlighting.
    const RECIPES = [
        ["import:\n    echo hi\n", "import"],
        ["import p:\n    echo hi\n", "import"],
        ["mod p:\n    echo hi\n", "mod"],
        ['mod q="1":\n    echo hi\n', "mod"],
        ["set shell:\n    echo hi\n", "set"],
        ["alias p:\n    echo hi\n", "alias"],
    ] as const;

    for (const [source, name] of RECIPES) {
        it(`scopes \`${source.split("\n")[0]}\` as a recipe`, async () => {
            expect(await scopesAt(source, name)).toContain("entity.name.function.just");
        });
    }

    it("still scopes the keyword forms as keywords", async () => {
        expect(await scopesAt('import "x.just"\n', "import")).toContain(
            "keyword.control.import.just",
        );
        expect(await scopesAt('import? "x.just"\n', "import")).toContain(
            "keyword.control.import.just",
        );
        expect(await scopesAt('mod sub "s.just"\n', "sub")).toContain("entity.name.namespace.just");
        expect(await scopesAt("mod?sub\n", "sub")).toContain("entity.name.namespace.just");
        expect(await scopesAt('set shell := ["a"]\n', "shell")).toContain(
            "support.type.property-name.just",
        );
    });

    it("does not count a colon inside a quoted or backticked run", async () => {
        // The guard skips these runs, so a path or command holding a colon does
        // not make the line look like a recipe header.
        expect(await scopesAt('mod sub "a:b.just"\n', "sub")).toContain(
            "entity.name.namespace.just",
        );
        expect(await scopesAt('set shell := ["a", "b:c"]\n', "shell")).toContain(
            "support.type.property-name.just",
        );
        expect(await scopesAt("set tempdir := `echo /a:b`\n", "tempdir")).toContain(
            "support.type.property-name.just",
        );
    });
});

describe("keyword lines carrying a trailing comment", () => {
    // A colon in a trailing comment must not make the line look like a recipe
    // header. A URL in one is enough on its own, and is common.
    const CASES = [
        ['import "x.just" # see https://a.b\n', "import", "keyword.control.import.just"],
        ['mod docs "d.just" # docs: here\n', "docs", "entity.name.namespace.just"],
        ["set dotenv-load # note: yes\n", "dotenv-load", "support.type.property-name.just"],
        [
            "set unstable # see https://just.systems\n",
            "unstable",
            "support.type.property-name.just",
        ],
    ] as const;

    for (const [source, needle, scope] of CASES) {
        it(`keeps \`${source.trim()}\` a keyword item`, async () => {
            expect(await scopesAt(source, needle)).toContain(scope);
            expect(await scopesAt(source, "#")).toContain("comment.line.number-sign.just");
        });
    }

    it("still ends a recipe header at its colon, comment or not", async () => {
        expect(await scopesAt("mod p: # note\n", "mod")).toContain("entity.name.function.just");
    });
});

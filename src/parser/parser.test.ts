import { describe, expect, it } from "vitest";
import { modelFromSource } from "../model/build.js";
import { parse } from "./parser.js";

describe("parser totality", () => {
    it("bounds expression nesting rather than overflowing the stack", () => {
        // Unbounded recursive descent throws RangeError here, which escapes the
        // parser and breaks the promise that parse() returns a Justfile for any
        // input. Depth 5000 was where it overflowed before the bound was added.
        for (const depth of [10, 500, 5_000, 50_000]) {
            const expr = `${"if a == b { ".repeat(depth)}x${" } else { y }".repeat(depth)}`;
            expect(() => parse(`v := ${expr}`), `depth ${depth}`).not.toThrow();
        }
    });

    it("survives a long else-if chain without exhausting the stack", () => {
        // `else if` is a flat chain, not nesting. Recursing once per clause
        // overflowed the stack at 20,000 clauses.
        for (const n of [10, 5_000, 50_000]) {
            const chain = `if a == b { x }${" else if c == d { y }".repeat(n)} else { z }`;
            expect(() => parse(`v := ${chain}`), `chain ${n}`).not.toThrow();
        }
    });

    it("does not report a syntax error on a long chain that just accepts", () => {
        // Verified against just 1.58.0: a 300-clause chain is legal. Spending
        // the depth budget per clause would squiggle a file just runs happily.
        const chain = `if a == "1" { "x" }${' else if a == "1" { "y" }'.repeat(300)} else { "z" }`;
        const ast = parse(`a := "1"\nv := ${chain}\n`);
        expect(ast.errors).toEqual([]);
    });

    it("keeps the chain's clauses linked in order", () => {
        const ast = parse('v := if a == "1" { "x" } else if b == "2" { "y" } else { "z" }\n');
        const item = ast.items.find((i) => i.kind === "assignment");
        expect(item?.kind).toBe("assignment");
        let node = item?.kind === "assignment" ? item.value : undefined;
        let clauses = 0;
        while (node?.kind === "conditional") {
            clauses++;
            node = node.alternative;
        }
        expect(clauses).toBe(2);
    });

    it("bounds nested calls and groups too", () => {
        const calls = `${"f(".repeat(5_000)}x${")".repeat(5_000)}`;
        expect(() => parse(`v := ${calls}`)).not.toThrow();
        const groups = `${"(".repeat(5_000)}x${")".repeat(5_000)}`;
        expect(() => parse(`v := ${groups}`)).not.toThrow();
    });

    it("still returns a Justfile when an expression is cut short", () => {
        const expr = `${"if a == b { ".repeat(1_000)}x${" } else { y }".repeat(1_000)}`;
        const ast = parse(`v := ${expr}\n\nbuild:\n    echo hi\n`);
        expect(ast.kind).toBe("justfile");
        expect(ast.errors.length).toBeGreaterThan(0);
    });
});

describe("item spans", () => {
    /** The source each item's span actually covers. */
    const covers = (source: string): string[] =>
        parse(source).items.map((item) =>
            source.slice(item.span.offset, item.span.offset + item.span.length),
        );

    it("stops an item before the next one begins", () => {
        // A span built from the next *unconsumed* token swallows that token, so
        // every item covered the first character of its neighbour. Nothing
        // noticed: the dump carries no spans, so the differential suite cannot
        // see this, and it only shows up once a feature uses a range.
        // The trailing newline is left out too, so clicking a symbol in the
        // outline does not select through the line break into the next line.
        expect(covers("a:\n    echo a\nb:\n    echo b\n")).toEqual([
            "a:\n    echo a",
            "b:\n    echo b",
        ]);
    });

    it("never lets two items overlap", () => {
        const source = `set shell := ["bash"]
x := "1"

[group('g')]
build target="d": dep
    echo {{ target }}

alias b := build
mod sub
`;
        const items = parse(source).items;
        for (let i = 1; i < items.length; i++) {
            const previous = items[i - 1];
            const current = items[i];
            if (previous === undefined || current === undefined) {
                continue;
            }
            expect(
                current.span.offset,
                `item ${i} starts inside item ${i - 1}`,
            ).toBeGreaterThanOrEqual(previous.span.offset + previous.span.length);
        }
    });

    it("keeps every span inside the document", () => {
        const source = 'x := "1"\nbuild:\n    echo hi\n';
        for (const item of parse(source).items) {
            expect(item.span.offset + item.span.length).toBeLessThanOrEqual(source.length);
        }
    });

    it("covers a one-line item exactly, without its newline", () => {
        expect(covers('x := "1"\n')).toEqual(['x := "1"']);
        expect(covers("set quiet\n")).toEqual(["set quiet"]);
        expect(covers("alias b := build\n")).toEqual(["alias b := build"]);
        expect(covers('import "other.just"\n')).toEqual(['import "other.just"']);
    });

    it("covers a whole setting line even when the value cannot be parsed", () => {
        // `set shell := ["bash"]` is valid just that the expression parser
        // cannot read yet. Taking the span where parsing gave up left the item
        // covering `set shell := [`, which is what the outline would select.
        expect(covers('set shell := ["bash", "-c"]\n')).toEqual(['set shell := ["bash", "-c"]']);
    });

    it("never gives a node a zero-width span", () => {
        // A production that consumes nothing must not collapse: an error node
        // with no width cannot be highlighted or pointed at.
        for (const source of ["build (x):\n    echo hi\n", "build 1 y:\n    echo hi\n"]) {
            const recipe = parse(source).items[0];
            if (recipe?.kind !== "recipe") {
                continue;
            }
            for (const parameter of recipe.parameters) {
                expect(parameter.span.length, source).toBeGreaterThan(0);
            }
        }
    });
});

describe("expression spans", () => {
    /** Every span in an expression tree, with the text it covers. */
    function spansOf(source: string): Map<string, string> {
        const item = parse(source).items[0];
        const found = new Map<string, string>();
        const walk = (node: unknown): void => {
            if (typeof node !== "object" || node === null) {
                return;
            }
            const record = node as { kind?: string; span?: { offset: number; length: number } };
            if (record.kind !== undefined && record.span !== undefined) {
                found.set(
                    record.kind,
                    source.slice(record.span.offset, record.span.offset + record.span.length),
                );
            }
            for (const value of Object.values(record)) {
                if (Array.isArray(value)) {
                    value.forEach(walk);
                } else {
                    walk(value);
                }
            }
        };
        walk(item);
        return found;
    }

    it("stops a parenthesised group at its closing bracket", () => {
        expect(spansOf('x := (a) + "b"\n').get("group")).toBe("(a)");
    });

    it("stops a call at its closing bracket", () => {
        // A hover or signature-help keyed on a call's span would otherwise
        // treat the operator after it as part of the call.
        expect(spansOf('x := env("A") + "b"\n').get("call")).toBe('env("A")');
    });

    it("stops a list at its closing bracket", () => {
        expect(spansOf('x := ["a"] + "b"\n').get("list")).toBe('["a"]');
    });

    it("stops a multi-line list at its closing bracket", () => {
        expect(spansOf('x := [\n    "a",\n]\n').get("list")).toBe('[\n    "a",\n]');
    });

    it("stops a multi-line group at its closing paren", () => {
        expect(spansOf('x := (\n    "a"\n) + "b"\n').get("group")).toBe('(\n    "a"\n)');
    });

    it("stops a multi-line call at its closing paren", () => {
        expect(spansOf('x := env(\n    "A"\n) + "b"\n').get("call")).toBe('env(\n    "A"\n)');
    });

    it("stops an interpolation at its closing braces", () => {
        expect(spansOf("build:\n    echo {{ a }} tail\n").get("interpolation")).toBe("{{ a }}");
    });

    it("holds at every truncation", () => {
        const source = 'x := "1"\nbuild p="q": dep\n    echo {{ p }}\nalias b := build\n';
        for (let i = 0; i <= source.length; i++) {
            const prefix = source.slice(0, i);
            for (const item of parse(prefix).items) {
                expect(item.span.offset, `truncation ${i}`).toBeGreaterThanOrEqual(0);
                expect(item.span.offset + item.span.length, `truncation ${i}`).toBeLessThanOrEqual(
                    prefix.length,
                );
            }
        }
    });

    it("keeps a parameter's span off the colon that ends the signature", () => {
        const source = "build target:\n    echo hi\n";
        const recipe = parse(source).items[0];
        expect(recipe?.kind).toBe("recipe");
        if (recipe?.kind !== "recipe") {
            return;
        }
        const parameter = recipe.parameters[0];
        expect(parameter).toBeDefined();
        if (parameter === undefined) {
            return;
        }
        const text = source.slice(
            parameter.span.offset,
            parameter.span.offset + parameter.span.length,
        );
        expect(text).toBe("target");
    });
});

describe("parenthesised groups", () => {
    it("rejects an empty group, matching just", () => {
        // just requires an expression inside `(...)` and rejects `()`
        // outright ("expected backtick, ... but found )"). Treating it as an
        // empty group with no error would be a missing squiggle on code just
        // does not accept.
        for (const source of ["x := ()\n", 'x := () + "a"\n']) {
            expect(parse(source).errors, source).not.toEqual([]);
        }
    });

    it("still never throws on an empty group", () => {
        expect(() => parse("x := ()\n")).not.toThrow();
    });
});

describe("recovery around unterminated strings", () => {
    it("still finds the recipe below an EOF-unterminated string", () => {
        const model = modelFromSource('broken := "oops\n\nbuild:\n    echo hi\n');
        expect(model.recipes.map((r) => r.name)).toEqual(["build"]);
        expect(model.assignments.map((a) => a.name)).toEqual(["broken"]);
    });

    it("treats a genuinely multi-line string as one value, matching just", () => {
        // just parses this as a single assignment whose value contains a
        // newline; there is no recipe here as far as just is concerned either.
        const model = modelFromSource('a := "one\ntwo"\n\nbuild:\n    echo hi\n');
        expect(model.assignments.map((x) => x.name)).toEqual(["a"]);
        expect(model.recipes.map((r) => r.name)).toEqual(["build"]);
    });
});

describe("list literals", () => {
    /** The value of the first item, when it is a list. */
    function listOf(source: string) {
        const item = parse(source).items[0];
        const value = item !== undefined && "value" in item ? item.value : undefined;
        expect(value?.kind).toBe("list");
        return value?.kind === "list" ? value : undefined;
    }

    it("reads the value of `set shell`", () => {
        const list = listOf('set shell := ["bash", "-cu"]\n');
        expect(list?.elements.map((e) => (e.kind === "string" ? e.value : e.kind))).toEqual([
            "bash",
            "-cu",
        ]);
    });

    it("reports no error on a list just accepts", () => {
        for (const source of [
            'set shell := ["bash", "-cu"]\n',
            'set windows-shell := ["pwsh", "-c"]\n',
            'set script-interpreter := ["sh", "-eu"]\n',
            'set shell := ["a",]\n',
        ]) {
            expect(parse(source).errors, source).toEqual([]);
        }
    });

    it("accepts a list anywhere an expression goes, and never mentions `set lists`", () => {
        // just parses `[` as an expression everywhere and only rejects the
        // result during evaluation — an unclosed bracket is reported before the
        // `set lists` gate is ever consulted. That gate is semantic, so it is
        // Tier 2's to enforce; see AGENTS.md invariant 1.
        for (const source of [
            'x := ["a"]\n',
            'r p=["a"]:\n    echo\n',
            'b x:\nr: (b ["a"])\n',
            'r:\n    echo {{ ["a"] }}\n',
            'x := [["a"], "b"]\n',
        ]) {
            expect(parse(source).errors, source).toEqual([]);
        }
    });

    it("reports no error on an attribute-shaped list that a bracket actually closes", () => {
        // `[private]` is also valid syntax for a one-element list, and an
        // unclosed bracket needs `[private]` to read as the recipe below's
        // own attribute instead — but when the bracket genuinely does close
        // (a comma or the closing bracket follows), that recovery guess must
        // not fire on code `just` accepts cleanly. See `parseCommaSeparated`.
        for (const source of [
            "x := foo(\n[private]\n)\n",
            "x := [\n[private]\n]\n",
            'x := [\n[private],\n"a"\n]\n',
        ]) {
            expect(parse(source).errors, source).toEqual([]);
        }
    });

    it("parses elements as full expressions", () => {
        const list = listOf(
            'x := [a, f("z"), (b), "c" + "d", if "1" == "1" { "y" } else { "n" }]\n',
        );
        expect(list?.elements.map((e) => e.kind)).toEqual([
            "variable",
            "call",
            "group",
            "concat",
            "conditional",
        ]);
    });

    it("keeps an empty list rather than calling it a syntax error", () => {
        // just rejects `[]` today. Saying so would put a squiggle on a
        // construct a later release could accept, and a wrong squiggle costs
        // more than a missing one.
        const parsed = parse("set shell := []\n");
        expect(parsed.errors).toEqual([]);
        expect(listOf("set shell := []\n")?.elements).toEqual([]);
    });

    describe("in the model", () => {
        /** The first setting's recorded list, if it has one. */
        function listValue(source: string) {
            return modelFromSource(source).settings[0]?.list;
        }

        it("records the strings of a string-list setting", () => {
            expect(listValue('set shell := ["bash", "-cu"]\n')).toEqual(["bash", "-cu"]);
            expect(listValue('set windows-shell := [\n    "pwsh",\n    "-c",\n]\n')).toEqual([
                "pwsh",
                "-c",
            ]);
        });

        it("records nothing for a value that would have to be evaluated", () => {
            // `sh` is a variable and `[...]` a nested list: resolving either
            // means running just's evaluator, which Tier 1 must not do.
            expect(listValue('set shell := [sh, "-c"]\n')).toBeUndefined();
            expect(listValue('set shell := [f("x")]\n')).toBeUndefined();
        });

        it("records nothing for a value that is not a list", () => {
            expect(listValue("set dotenv-load := true\n")).toBeUndefined();
            expect(listValue("set export\n")).toBeUndefined();
            expect(listValue('set tempdir := "/tmp"\n')).toBeUndefined();
        });

        it("records nothing when a string in the list never closed", () => {
            expect(listValue('set shell := ["bash\n')).toBeUndefined();
        });
    });

    describe("across lines", () => {
        it("reads a list split over several lines", () => {
            const list = listOf('set shell := [\n    "bash",\n    "-cu",\n]\n');
            expect(list?.elements).toHaveLength(2);
        });

        it("reads elements written flush against the left margin", () => {
            // just allows any indentation inside the brackets, so a column-zero
            // element is a continuation line and not a new item.
            expect(listOf('set shell := [\n"bash",\n"-cu",\n]\n')?.elements).toHaveLength(2);
        });

        it("reads a list whose commas start their own lines", () => {
            // just is indifferent to where the newlines fall between the
            // brackets, so a comma on its own line is still a separator.
            expect(
                listOf('set shell := [\n    "bash"\n    ,\n    "-cu"\n]\n')?.elements,
            ).toHaveLength(2);
        });

        it("covers every line of a multi-line setting", () => {
            const source = 'set shell := [\n    "bash",\n]\n';
            const item = parse(source).items[0];
            expect(
                source.slice(
                    item?.span.offset,
                    (item?.span.offset ?? 0) + (item?.span.length ?? 0),
                ),
            ).toBe('set shell := [\n    "bash",\n]');
        });

        it("does not swallow the item below a blank line inside the list", () => {
            const model = modelFromSource(
                'set shell := [\n\n    "bash"\n\n]\n\nbuild:\n    echo hi\n',
            );
            expect(model.recipes.map((r) => r.name)).toEqual(["build"]);
        });
    });

    describe("recovery from a missing `]`", () => {
        it("reports the missing bracket once", () => {
            const parsed = parse('set shell := ["a"\nbuild:\n    echo hi\n');
            expect(parsed.errors.map((e) => e.message)).toEqual(["expected `]`"]);
        });

        it("stops at the recipe below instead of eating the rest of the file", () => {
            // Without a bound the list runs to end of file, and one missing
            // bracket costs the whole outline.
            const model = modelFromSource(
                'set shell := ["a"\n\nbuild:\n    echo hi\n\ntest:\n    echo bye\n',
            );
            expect(model.recipes.map((r) => r.name)).toEqual(["build", "test"]);
        });

        it("stops at an item keyword below", () => {
            const model = modelFromSource('set shell := ["a"\nset export := true\nx := "1"\n');
            expect(model.settings.map((s) => s.name)).toEqual(["shell", "export"]);
            expect(model.assignments.map((a) => a.name)).toEqual(["x"]);
        });

        it("leaves an attribute below it attached to its own recipe", () => {
            // Reading `[private]` as a nested list would leave the recipe
            // looking public, which is a wrong answer rather than a missing one.
            const model = modelFromSource('set shell := ["a"\n[private]\nbuild:\n    echo hi\n');
            expect(model.recipes.map((r) => `${r.name}:${r.private}`)).toEqual(["build:true"]);
        });

        it("keeps a nested list at the left margin inside the outer list", () => {
            // The bail-out needs a name after the bracket, as the grammar's
            // does: `[` before anything else is a nested list, not an attribute.
            // just accepts this whole thing as one assignment.
            const parsed = parse('x := [\n["a"],\n]\n');
            expect(parsed.errors).toEqual([]);
            expect(parsed.items.map((i) => i.kind)).toEqual(["assignment"]);
        });

        it("keeps an alias below it", () => {
            const model = modelFromSource('build:\n    echo hi\nx := ["a"\nalias b := build\n');
            expect(model.aliases.map((a) => a.name)).toEqual(["b"]);
        });

        it("terminates on input that offers nothing to close it", () => {
            for (const source of [
                'x := ["a"',
                "x := [",
                "x := [,,,,\n",
                'x := [\n\n\n"a"',
                "x := []]",
            ]) {
                expect(() => parse(source), source).not.toThrow();
            }
        });
    });
});

describe("newlines inside parentheses and call arguments", () => {
    /** The value of the first assignment. */
    function assignmentValue(source: string) {
        const item = parse(source).items[0];
        return item !== undefined && "value" in item ? item.value : undefined;
    }

    it("reports no error on a group, join or call split across lines", () => {
        for (const source of [
            'x := (\n    "a"\n)\n',
            'x := (\n    "a" +\n    "b"\n)\n',
            'x := (\n    "a"\n    + "b"\n)\n',
            'x := (\n    "a" /\n    "b"\n)\n',
            'x := (\n    / "a"\n)\n',
            'x := lowercase(\n    "a",\n    "b"\n)\n',
            'x := lowercase(\n    "a"\n    ,\n    "b"\n)\n',
            'x := lowercase(\n    "a" +\n    "b"\n)\n',
            'x := (\n    lowercase(\n        "a"\n    ) + "b"\n)\n',
        ]) {
            expect(parse(source).errors, source).toEqual([]);
        }
    });

    it("keeps the same shape whether or not the same expression is split", () => {
        const oneLine = assignmentValue('x := lowercase("a", "b") + ("c" / "d")\n');
        const split = assignmentValue(
            'x := lowercase(\n    "a",\n    "b"\n) + (\n    "c" /\n    "d"\n)\n',
        );
        expect(split?.kind).toBe(oneLine?.kind);
        expect(split?.kind).toBe("concat");
        if (split?.kind !== "concat" || oneLine?.kind !== "concat") {
            return;
        }
        expect(split.left.kind).toBe("call");
        expect(split.right?.kind).toBe("group");
    });

    it("a newline still ends a value at the top level, outside any paren", () => {
        // parenDepth must not leak between one assignment and the next — only
        // a newline lexically inside an unmatched `(` loses its meaning.
        const model = modelFromSource('x := "a"\ny := "b"\n');
        expect(model.assignments.map((a) => a.name)).toEqual(["x", "y"]);
    });

    it("a parameter default may split across lines, since its colon comes after it", () => {
        const model = modelFromSource('build target=(\n    lowercase("A")\n):\n    echo hi\n');
        expect(model.recipes.map((r) => r.name)).toEqual(["build"]);
        expect(model.recipes[0]?.parameters[0]?.hasDefault).toBe(true);
    });

    describe("recovery from a missing `)`", () => {
        it("reports the missing paren once", () => {
            const parsed = parse('x := ("a"\nbuild:\n    echo hi\n');
            expect(parsed.errors.map((e) => e.message)).toEqual(["expected `)`"]);
        });

        it("stops at the recipe below instead of eating the rest of the file", () => {
            const model = modelFromSource(
                'x := ("a"\n\nbuild:\n    echo hi\n\ntest:\n    echo bye\n',
            );
            expect(model.recipes.map((r) => r.name)).toEqual(["build", "test"]);
        });

        it("stops at an item keyword below", () => {
            const model = modelFromSource('x := ("a"\nset export := true\ny := "1"\n');
            expect(model.assignments.map((a) => a.name)).toEqual(["x", "y"]);
            expect(model.settings.map((s) => s.name)).toEqual(["export"]);
        });

        it("keeps an alias below it", () => {
            const model = modelFromSource('build:\n    echo hi\nx := ("a"\nalias b := build\n');
            expect(model.aliases.map((a) => a.name)).toEqual(["b"]);
        });

        it("reports the missing paren once for an unclosed call", () => {
            const parsed = parse('x := lowercase("a"\nbuild:\n    echo hi\n');
            expect(parsed.errors.map((e) => e.message)).toEqual(["expected `)`"]);
        });

        it("terminates on input that offers nothing to close it", () => {
            for (const source of [
                'x := ("a"',
                "x := (",
                "x := lowercase(",
                "x := lowercase(,,,,\n",
                'x := (\n\n\n"a"',
                "x := ())",
            ]) {
                expect(() => parse(source), source).not.toThrow();
            }
        });
    });
});

describe("keywords are not reserved words", () => {
    /** Item kinds and names, as `kind:name`, in the order the model reports. */
    function items(source: string): string[] {
        const model = modelFromSource(source);
        return [
            ...model.settings.map((s) => `setting:${s.name}`),
            ...model.aliases.map((a) => `alias:${a.name}`),
            ...model.modules.map((m) => `module:${m.name}${m.optional ? "?" : ""}`),
            ...model.imports.map((i) => `import:${i.path}`),
            ...model.recipes.map((r) => `recipe:${r.name}(${r.parameters.map((p) => p.name)})`),
        ];
    }

    it("reads a recipe whose name is a keyword", () => {
        // Verified against just 1.58.0: every one of these is a recipe. The
        // word a line starts with cannot decide what the line is.
        expect(items("import:\n    echo hi\n")).toEqual(["recipe:import()"]);
        expect(items("mod:\n    echo hi\n")).toEqual(["recipe:mod()"]);
        expect(items("set:\n    echo hi\n")).toEqual(["recipe:set()"]);
        expect(items("alias:\n    echo hi\n")).toEqual(["recipe:alias()"]);
    });

    it("reads a keyword-named recipe that takes parameters", () => {
        // `mod p:` used to become a module named "p", and `set p:` a setting
        // named "p" — the recipe vanished and something the file never wrote
        // took its place.
        expect(items("mod p:\n    echo hi\n")).toEqual(["recipe:mod(p)"]);
        expect(items("set p:\n    echo hi\n")).toEqual(["recipe:set(p)"]);
        expect(items("import p:\n    echo hi\n")).toEqual(["recipe:import(p)"]);
        expect(items('alias p="q":\n    echo hi\n')).toEqual(["recipe:alias(p)"]);
    });

    it("still reads the keyword forms as items", () => {
        expect(items("set dotenv-load := true\n")).toEqual(["setting:dotenv-load"]);
        expect(items("build:\n    echo\nalias b := build\n")).toEqual([
            "alias:b",
            "recipe:build()",
        ]);
        expect(items('import "x.just"\n')).toEqual(["import:x.just"]);
        expect(items('import? "x.just"\n')).toEqual(["import:x.just"]);
        expect(items('mod sub "s.just"\n')).toEqual(["module:sub"]);
    });

    it("reads an optional module however the `?` is spaced", () => {
        // `?` cannot appear in a name, so just needs no space around it. A
        // dispatch that looks only at the token after `mod` sees `?`, gives up,
        // and reads the whole line as a recipe named "mod".
        for (const source of ["mod? sub\n", "mod?sub\n", "mod?   sub\n"]) {
            expect(items(source), source).toEqual(["module:sub?"]);
        }
    });

    it("recovers to a keyword item below an unclosed list", () => {
        expect(items('set shell := ["a"\nmod?sub\n')).toEqual(["setting:shell", "module:sub?"]);
        expect(items('set shell := ["a"\nimport:\n    echo\n')).toEqual([
            "setting:shell",
            "recipe:import()",
        ]);
    });
});

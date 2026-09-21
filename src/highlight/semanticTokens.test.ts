import { describe, expect, it } from "vitest";
import { parse } from "../parser/parser.js";
import {
    encodeModifiers,
    normalise,
    type SemanticToken,
    semanticTokens,
    TOKEN_MODIFIERS,
    TOKEN_TYPES,
    TokenModifier,
    TokenType,
    typeIndex,
} from "./semanticTokens.js";

interface Scoped {
    readonly text: string;
    readonly type: string;
    readonly modifiers: readonly string[];
}

/** Tokens paired with the source they cover, so assertions read as source. */
function scoped(source: string): Scoped[] {
    const lines = source.split("\n");
    return semanticTokens(parse(source)).map((token: SemanticToken) => ({
        text: (lines[token.line] ?? "").slice(
            token.startCharacter,
            token.startCharacter + token.length,
        ),
        type: token.type,
        modifiers: token.modifiers,
    }));
}

describe("definitions and references", () => {
    it("tells a recipe definition from a use of it", () => {
        // The whole reason this layer exists: to a grammar rule these two are
        // the same word in the same shape.
        const tokens = scoped("build:\n    echo b\n\ndeploy: build\n    echo d\n");
        expect(tokens).toContainEqual({
            text: "build",
            type: TokenType.Function,
            modifiers: [TokenModifier.Declaration],
        });
        expect(tokens).toContainEqual({
            text: "build",
            type: TokenType.Function,
            modifiers: [],
        });
    });

    it("marks a dependency that runs afterwards the same as one that runs before", () => {
        const tokens = scoped("a:\n    echo a\nb:\n    echo b\nc: a && b\n    echo c\n");
        const references = tokens.filter(
            (t) => t.type === TokenType.Function && t.modifiers.length === 0,
        );
        expect(references.map((t) => t.text)).toEqual(["a", "b"]);
    });

    it("tells an assignment from a reference to it", () => {
        const tokens = scoped('version := "1"\n\nshow:\n    echo {{ version }}\n');
        expect(tokens).toContainEqual({
            text: "version",
            type: TokenType.Variable,
            modifiers: [TokenModifier.Declaration],
        });
        expect(tokens).toContainEqual({
            text: "version",
            type: TokenType.Variable,
            modifiers: [],
        });
    });
});

describe("parameters", () => {
    it("marks a parameter and the uses of it inside its recipe", () => {
        const tokens = scoped("greet target:\n    echo {{ target }}\n");
        expect(tokens).toContainEqual({
            text: "target",
            type: TokenType.Parameter,
            modifiers: [TokenModifier.Declaration],
        });
        expect(tokens).toContainEqual({
            text: "target",
            type: TokenType.Parameter,
            modifiers: [],
        });
    });

    it("does not leak one recipe's parameters into another", () => {
        // `target` is a parameter of `greet` and a plain variable in `other`.
        const source =
            'target := "x"\n\ngreet target:\n    echo {{ target }}\n\nother:\n    echo {{ target }}\n';
        const uses = scoped(source).filter((t) => t.text === "target" && t.modifiers.length === 0);
        expect(uses.map((t) => t.type)).toEqual([TokenType.Parameter, TokenType.Variable]);
    });

    it("resolves a parameter used in another parameter's default", () => {
        const tokens = scoped("build a b=a:\n    echo hi\n");
        const uses = tokens.filter((t) => t.text === "a");
        expect(uses.map((t) => t.type)).toEqual([TokenType.Parameter, TokenType.Parameter]);
        expect(uses.map((t) => t.modifiers)).toEqual([[TokenModifier.Declaration], []]);
    });

    it("marks variadic and exported parameters no differently", () => {
        const tokens = scoped("run $env *rest:\n    echo hi\n");
        const names = tokens.filter((t) => t.type === TokenType.Parameter).map((t) => t.text);
        expect(names).toEqual(["env", "rest"]);
    });
});

describe("the other items", () => {
    it("marks an attribute as a decorator", () => {
        const tokens = scoped("[group('build')]\n[private]\nfoo:\n    echo hi\n");
        const decorators = tokens.filter((t) => t.type === TokenType.Decorator);
        expect(decorators.map((t) => t.text)).toEqual(["group", "private"]);
    });

    it("marks a setting name as a property", () => {
        const tokens = scoped('set shell := ["bash"]\nset dotenv-load\n');
        const properties = tokens.filter((t) => t.type === TokenType.Property);
        expect(properties.map((t) => t.text)).toEqual(["shell", "dotenv-load"]);
    });

    it("marks an alias and the recipe it points at", () => {
        const tokens = scoped("build:\n    echo b\n\nalias b := build\n");
        expect(tokens).toContainEqual({
            text: "b",
            type: TokenType.Function,
            modifiers: [TokenModifier.Declaration],
        });
        const targets = tokens.filter((t) => t.text === "build" && t.modifiers.length === 0);
        expect(targets).toHaveLength(1);
    });

    it("marks a module as a namespace", () => {
        const tokens = scoped('mod docs "docs/justfile"\n');
        expect(tokens).toContainEqual({
            text: "docs",
            type: TokenType.Namespace,
            modifiers: [TokenModifier.Declaration],
        });
    });

    it("marks a built-in call as coming from the standard library", () => {
        // just has no user-defined functions, so every callee is a built-in.
        const tokens = scoped("dir := justfile_directory()\n");
        expect(tokens).toContainEqual({
            text: "justfile_directory",
            type: TokenType.Function,
            modifiers: [TokenModifier.DefaultLibrary],
        });
    });

    it("reaches names nested deep inside an expression", () => {
        const tokens = scoped("x := if a == b { uppercase(c) } else { d / e }\n");
        const names = tokens.filter((t) => t.type === TokenType.Variable).map((t) => t.text);
        expect(names).toEqual(["x", "a", "b", "c", "d", "e"]);
    });
});

describe("the shape the protocol demands", () => {
    const BUSY = `set shell := ["bash"]

# a comment
[group('x')]
@build target="release" *flags: fetch && report
    #!/usr/bin/env bash
    echo {{ target }} {{ uppercase(flags) }}

fetch:
    echo f

report:
    echo r

alias b := build
mod sub "sub/justfile"
`;

    it("returns tokens sorted by position", () => {
        const tokens = semanticTokens(parse(BUSY));
        for (let i = 1; i < tokens.length; i++) {
            const previous = tokens[i - 1];
            const current = tokens[i];
            if (previous === undefined || current === undefined) {
                continue;
            }
            const ordered =
                previous.line < current.line ||
                (previous.line === current.line &&
                    previous.startCharacter <= current.startCharacter);
            expect(ordered, `token ${i} is out of order`).toBe(true);
        }
    });

    it("never returns two tokens that overlap", () => {
        // VS Code drops the whole batch rather than the offending token.
        const tokens = semanticTokens(parse(BUSY));
        for (let i = 1; i < tokens.length; i++) {
            const previous = tokens[i - 1];
            const current = tokens[i];
            if (previous === undefined || current === undefined || previous.line !== current.line) {
                continue;
            }
            expect(current.startCharacter).toBeGreaterThanOrEqual(
                previous.startCharacter + previous.length,
            );
        }
    });

    it("keeps every token on the line it starts on, covering something", () => {
        const lines = BUSY.split("\n");
        for (const token of semanticTokens(parse(BUSY))) {
            expect(token.length).toBeGreaterThan(0);
            expect(token.line).toBeLessThan(lines.length);
            const line = lines[token.line] ?? "";
            expect(token.startCharacter + token.length).toBeLessThanOrEqual(line.length);
        }
    });
});

describe("normalise", () => {
    // Fed deliberately bad input, because the tree walk does not currently
    // produce any. That is exactly why this is tested here and not through
    // `semanticTokens`, where these cases cannot arise to begin with.
    const at = (line: number, startCharacter: number, length: number): SemanticToken => ({
        line,
        startCharacter,
        length,
        type: TokenType.Variable,
        modifiers: [],
    });

    it("sorts by line, then by character", () => {
        const sorted = normalise([at(2, 0, 1), at(0, 5, 1), at(1, 0, 1), at(0, 0, 1)]);
        expect(sorted.map((t) => [t.line, t.startCharacter])).toEqual([
            [0, 0],
            [0, 5],
            [1, 0],
            [2, 0],
        ]);
    });

    it("drops a token that overlaps the one before it", () => {
        // VS Code discards the entire batch on an overlap, so the later token
        // is worth losing to keep the rest.
        const kept = normalise([at(0, 0, 5), at(0, 3, 5)]);
        expect(kept).toEqual([at(0, 0, 5)]);
    });

    it("keeps tokens that merely touch", () => {
        const kept = normalise([at(0, 0, 3), at(0, 3, 3)]);
        expect(kept).toHaveLength(2);
    });

    it("does not treat the same columns on different lines as an overlap", () => {
        expect(normalise([at(0, 0, 5), at(1, 0, 5)])).toHaveLength(2);
    });

    it("leaves the input alone", () => {
        const input = [at(1, 0, 1), at(0, 0, 1)];
        normalise(input);
        expect(input.map((t) => t.line)).toEqual([1, 0]);
    });

    it("handles nothing", () => {
        expect(normalise([])).toEqual([]);
    });
});

describe("legend encoding", () => {
    it("indexes every type it can emit", () => {
        for (const type of TOKEN_TYPES) {
            expect(typeIndex(type)).toBeGreaterThanOrEqual(0);
        }
    });

    it("encodes modifiers as a bit set", () => {
        expect(encodeModifiers([])).toBe(0);
        expect(encodeModifiers([TokenModifier.Declaration])).toBe(
            1 << TOKEN_MODIFIERS.indexOf(TokenModifier.Declaration),
        );
        expect(encodeModifiers([TokenModifier.Declaration, TokenModifier.DefaultLibrary])).toBe(
            (1 << TOKEN_MODIFIERS.indexOf(TokenModifier.Declaration)) |
                (1 << TOKEN_MODIFIERS.indexOf(TokenModifier.DefaultLibrary)),
        );
    });

    it("uses only token types VS Code themes already know", () => {
        // Standard types from the LSP specification. A custom type would need
        // every theme to opt in, and would show up unstyled until they did.
        const standard = new Set([
            "namespace",
            "class",
            "enum",
            "interface",
            "struct",
            "typeParameter",
            "type",
            "parameter",
            "variable",
            "property",
            "enumMember",
            "decorator",
            "event",
            "function",
            "method",
            "macro",
            "label",
            "comment",
            "string",
            "keyword",
            "number",
            "regexp",
            "operator",
        ]);
        for (const type of TOKEN_TYPES) {
            expect(standard.has(type), type).toBe(true);
        }
    });
});

describe("totality", () => {
    it("returns tokens for a file the parser had to recover from", () => {
        const tokens = scoped('broken := "oops\n\nbuild:\n    echo hi\n');
        expect(tokens.some((t) => t.text === "broken")).toBe(true);
    });

    it("never throws, at any truncation of a real file", () => {
        // The same trick the differential suite uses: truncating at every byte
        // simulates typing the file one character at a time.
        const source = `set shell := ["bash"]
[group('x')]
@build target="release" *flags: fetch && report
    echo {{ uppercase(target) }}
alias b := build
mod sub
`;
        for (let i = 0; i <= source.length; i++) {
            expect(
                () => semanticTokens(parse(source.slice(0, i))),
                `truncation ${i}`,
            ).not.toThrow();
        }
    });

    it("holds the protocol's shape even on truncated input", () => {
        const source = 'x := if a == b { c } else { d }\nbuild p="q": dep\n    echo {{ p }}\n';
        for (let i = 0; i <= source.length; i++) {
            const tokens = semanticTokens(parse(source.slice(0, i)));
            for (let j = 1; j < tokens.length; j++) {
                const previous = tokens[j - 1];
                const current = tokens[j];
                if (previous === undefined || current === undefined) {
                    continue;
                }
                expect(
                    previous.line < current.line ||
                        (previous.line === current.line &&
                            current.startCharacter >= previous.startCharacter + previous.length),
                    `truncation ${i}, token ${j}`,
                ).toBe(true);
            }
        }
    });
});

describe("list literals", () => {
    it("colours names inside a list", () => {
        // The expression walk falls through to a `default` that colours
        // nothing, so a missing case here is silent: the list highlights, and
        // only the names inside it quietly lose their colour.
        const tokens = scoped('set shell := [sh, join("a", "b")]\n');
        expect(tokens).toContainEqual({ text: "sh", type: TokenType.Variable, modifiers: [] });
        expect(tokens).toContainEqual({
            text: "join",
            type: TokenType.Function,
            modifiers: [TokenModifier.DefaultLibrary],
        });
    });

    it("colours a recipe's parameter used inside a list", () => {
        const tokens = scoped("r p:\n    echo {{ [p] }}\n");
        expect(tokens).toContainEqual({ text: "p", type: TokenType.Parameter, modifiers: [] });
    });
});

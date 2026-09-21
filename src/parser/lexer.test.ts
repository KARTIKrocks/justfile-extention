import { describe, expect, it } from "vitest";
import { tokenize } from "./lexer.js";
import { type Token, TokenKind } from "./token.js";

/** Token kinds only, with newlines dropped, so tests read as structure. */
function kinds(source: string): TokenKind[] {
    return tokenize(source)
        .map((t) => t.kind)
        .filter((k) => k !== TokenKind.Newline);
}

function texts(source: string, kind: TokenKind): string[] {
    return tokenize(source)
        .filter((t) => t.kind === kind)
        .map((t) => t.text);
}

function find(source: string, kind: TokenKind): Token | undefined {
    return tokenize(source).find((t) => t.kind === kind);
}

describe("lexer", () => {
    it("lexes an assignment", () => {
        expect(kinds('version := "1.0"')).toEqual([
            TokenKind.Identifier,
            TokenKind.ColonEquals,
            TokenKind.StringLiteral,
            TokenKind.Eof,
        ]);
    });

    it("distinguishes := from : so assignments do not open a recipe body", () => {
        // The indented line here is not a body; it is a badly indented item.
        expect(kinds('a := "x"\n    b := "y"\n')).not.toContain(TokenKind.Indent);
    });

    it("opens a body after a recipe header and closes it on dedent", () => {
        const source = "build:\n    echo hi\n\nnext:\n    echo bye\n";
        const k = kinds(source);
        expect(k.filter((x) => x === TokenKind.Indent)).toHaveLength(2);
        expect(k.filter((x) => x === TokenKind.Dedent)).toHaveLength(2);
    });

    it("treats a blank line inside a body as part of the body", () => {
        const source = "build:\n    one\n\n    two\n";
        expect(kinds(source).filter((k) => k === TokenKind.Dedent)).toHaveLength(1);
    });

    it("does not treat # inside a recipe body as a comment", () => {
        // In a body, `#` is shell text, not a justfile comment.
        expect(texts("build:\n    echo # not a comment\n", TokenKind.Comment)).toEqual([]);
    });

    it("lexes a top-level comment", () => {
        expect(texts("# a comment\nbuild:\n", TokenKind.Comment)).toEqual(["# a comment"]);
    });

    it("lexes interpolation inside a body", () => {
        const k = kinds("build target:\n    echo {{ target }}\n");
        expect(k).toContain(TokenKind.InterpolationStart);
        expect(k).toContain(TokenKind.InterpolationEnd);
    });

    it("processes escapes in double-quoted strings but not single-quoted ones", () => {
        expect(find('a := "x\\ny"', TokenKind.StringLiteral)?.value).toBe("x\ny");
        expect(find("a := 'x\\ny'", TokenKind.StringLiteral)?.value).toBe("x\\ny");
    });

    it("lexes triple-quoted strings as one token", () => {
        expect(texts("a := '''one\ntwo'''\n", TokenKind.StringLiteral)).toEqual(["'''one\ntwo'''"]);
    });

    it("lexes backticks, which just evaluates at parse time", () => {
        expect(texts("a := `echo hi`\n", TokenKind.Backtick)).toEqual(["`echo hi`"]);
    });

    it("lexes attributes", () => {
        const k = kinds("[group('build')]\nbuild:\n    x\n");
        expect(k.slice(0, 5)).toEqual([
            TokenKind.BracketL,
            TokenKind.Identifier,
            TokenKind.ParenL,
            TokenKind.StringLiteral,
            TokenKind.ParenR,
        ]);
    });
});

describe("lexer totality", () => {
    // The parser is only total if the lexer is. These are the inputs that
    // classically break hand-written lexers.
    const nasty = [
        "",
        "\n",
        "\r\n",
        '"',
        "'''",
        "`",
        '"unterminated',
        "{{",
        "build:\n    {{",
        "build:\n    {{ x",
        "\\",
        "a := \\",
        " ",
        "…🎉",
        "a".repeat(10_000),
        "\t\t\t\n\t\t\t",
        "build:\r\n\techo hi\r\n",
        "[",
        "]]",
        ":=",
        "::::",
    ];

    for (const source of nasty) {
        it(`survives ${JSON.stringify(source.slice(0, 24))}`, () => {
            const tokens = tokenize(source);
            expect(tokens.at(-1)?.kind).toBe(TokenKind.Eof);
        });
    }

    it("marks unterminated literals rather than throwing", () => {
        const token = find('a := "no end', TokenKind.StringLiteral);
        expect(token?.unterminated).toBe(true);
    });

    it("covers the source in order without overlapping", () => {
        const source = 'set shell := ["bash"]\n\n# c\nbuild dir="x":\n    echo {{ dir }} # hi\n';
        const tokens = tokenize(source).filter((t) => t.kind !== TokenKind.Eof);
        let offset = 0;
        for (const t of tokens) {
            expect(t.span.offset).toBeGreaterThanOrEqual(offset);
            offset = t.span.offset + t.span.length;
        }
        expect(offset).toBeLessThanOrEqual(source.length);
    });
});

describe("unterminated literal recovery", () => {
    // `just` accepts newlines inside both '...' and "..." — verified against
    // 1.58.0 — so scanning across them is correct, and a literal closed by a
    // quote further down the file genuinely does swallow the lines between.
    // Matching that beats a tidier outline that misrepresents the source.
    it("keeps a multi-line string as one token", () => {
        expect(texts('a := "one\ntwo"\n', TokenKind.StringLiteral)).toEqual(['"one\ntwo"']);
        expect(find('a := "one\ntwo"\n', TokenKind.StringLiteral)?.value).toBe("one\ntwo");
    });

    // Reaching EOF is different: `just` rejects such a file outright, so no
    // valid program depends on how we recover. Cutting the literal at its first
    // newline keeps the rest of the file parseable, which is what matters while
    // someone is still typing the closing quote.
    it("ends an EOF-unterminated string at its first newline", () => {
        const source = 'broken := "oops\n\nbuild:\n    echo hi\n';
        const token = find(source, TokenKind.StringLiteral);
        expect(token?.unterminated).toBe(true);
        expect(token?.text).toBe('"oops');
    });

    it("still lexes the recipe below an EOF-unterminated string", () => {
        const source = 'broken := "oops\n\nbuild:\n    echo hi\n';
        const identifiers = texts(source, TokenKind.Identifier);
        expect(identifiers).toContain("build");
        expect(kinds(source)).toContain(TokenKind.Indent);
    });

    it("recovers when the unterminated literal's lines all end in a backslash", () => {
        // A backslash-newline is a line continuation, so the escape consumes the
        // newline. If that newline is not noted as a recovery point, there is
        // nowhere to rewind to and the rest of the file is swallowed.
        const source = 'broken := "oops\\\nbuild:\\\n    echo hi\\\n';
        const token = find(source, TokenKind.StringLiteral);
        expect(token?.unterminated).toBe(true);
        expect(token?.text).toBe('"oops\\');
        expect(texts(source, TokenKind.Identifier)).toContain("build");
    });

    it("recovers at the escaped newline rather than a later one", () => {
        // Recovering one line too late invented a recipe named `echo` from the
        // body line, and lost `build` entirely — worse than dropping entries,
        // because the outline showed something that is not in the file.
        const source = 'broken := "oops\\\nbuild:\n    echo hi\n';
        expect(texts(source, TokenKind.Identifier)).toContain("build");
    });

    it("still joins a valid line continuation, which shares the escape path", () => {
        const token = find('a := "one\\\ntwo"\n', TokenKind.StringLiteral);
        expect(token?.unterminated).toBeUndefined();
        expect(token?.value).toBe("onetwo");
    });

    it("keeps indentation after a line continuation, as just does", () => {
        // just 1.58.0 reports this as `x    indented`. Stripping the leading
        // whitespace was an assumption, and it made every continued string in a
        // hover differ from the value just actually computes.
        const token = find('b := "x\\\n    indented"\n', TokenKind.StringLiteral);
        expect(token?.value).toBe("x    indented");
    });

    it("lets a triple-quoted literal run to EOF, since spanning lines is its purpose", () => {
        const token = find("a := '''one\ntwo\n", TokenKind.StringLiteral);
        expect(token?.unterminated).toBe(true);
        expect(token?.text).toBe("'''one\ntwo\n");
    });
});

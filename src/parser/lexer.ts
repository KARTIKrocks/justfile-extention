/**
 * Justfile lexer.
 *
 * Tier 1: no VS Code API, no I/O, no subprocesses. See AGENTS.md.
 *
 * Totality is the defining constraint. `tokenize` accepts any string and always
 * returns a token stream ending in Eof. It never throws, never returns null, and
 * never loops forever. Anything it cannot classify becomes an `Unknown` token
 * with a real span, so downstream consumers still get positions to work with.
 *
 * The grammar is line-oriented, which the lexer mirrors. At the top level it
 * produces ordinary tokens. After a recipe header it switches into body mode,
 * where lines are opaque shell text punctuated by `{{ ... }}` interpolations.
 */

import { type Span, StringStyle, type Token, TokenKind } from "./token.js";

const EOF = "";

interface MutableToken {
    kind: TokenKind;
    span: Span;
    text: string;
    value?: string;
    style?: StringStyle;
    unterminated?: boolean;
}

class Cursor {
    private readonly source: string;
    private offset = 0;
    private line = 0;
    private column = 0;

    // Parameter properties emit runtime code, which `erasableSyntaxOnly` forbids.
    constructor(source: string) {
        this.source = source;
    }

    get pos(): number {
        return this.offset;
    }

    get atEnd(): boolean {
        return this.offset >= this.source.length;
    }

    /** Character `n` ahead, or `""` past the end. Never undefined. */
    peek(n = 0): string {
        return this.source[this.offset + n] ?? EOF;
    }

    /** Does the source match `text` at the cursor? */
    lookingAt(text: string): boolean {
        return this.source.startsWith(text, this.offset);
    }

    advance(n = 1): void {
        for (let i = 0; i < n && this.offset < this.source.length; i++) {
            if (this.source[this.offset] === "\n") {
                this.line++;
                this.column = 0;
            } else {
                this.column++;
            }
            this.offset++;
        }
    }

    mark(): { offset: number; line: number; column: number } {
        return { offset: this.offset, line: this.line, column: this.column };
    }

    /** Rewind to a previous mark. Only used to recover from an unterminated literal. */
    reset(at: { offset: number; line: number; column: number }): void {
        this.offset = at.offset;
        this.line = at.line;
        this.column = at.column;
    }

    spanFrom(start: { offset: number; line: number; column: number }): Span {
        return {
            offset: start.offset,
            length: this.offset - start.offset,
            line: start.line,
            column: start.column,
        };
    }

    slice(from: number): string {
        return this.source.slice(from, this.offset);
    }
}

/** Operators, longest first so that `:=` wins over `:`. */
const OPERATORS: ReadonlyArray<readonly [string, TokenKind]> = [
    [":=", TokenKind.ColonEquals],
    ["==", TokenKind.EqualsEquals],
    ["!=", TokenKind.BangEquals],
    ["=~", TokenKind.EqualsTilde],
    ["&&", TokenKind.AmpAmp],
    ["{{", TokenKind.InterpolationStart],
    ["}}", TokenKind.InterpolationEnd],
    [":", TokenKind.Colon],
    [",", TokenKind.Comma],
    ["(", TokenKind.ParenL],
    [")", TokenKind.ParenR],
    ["[", TokenKind.BracketL],
    ["]", TokenKind.BracketR],
    ["@", TokenKind.At],
    ["$", TokenKind.Dollar],
    ["*", TokenKind.Asterisk],
    ["+", TokenKind.Plus],
    ["/", TokenKind.Slash],
    ["=", TokenKind.Equals],
    ["?", TokenKind.QuestionMark],
];

function isIdentStart(c: string): boolean {
    return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}

function isIdentContinue(c: string): boolean {
    return isIdentStart(c) || (c >= "0" && c <= "9") || c === "-";
}

function isHorizontalSpace(c: string): boolean {
    return c === " " || c === "\t";
}

/** Resolve escapes in a double-quoted or triple-double-quoted literal. */
function cook(raw: string): string {
    if (!raw.includes("\\")) {
        return raw;
    }
    let out = "";
    for (let i = 0; i < raw.length; i++) {
        if (raw[i] !== "\\") {
            out += raw[i];
            continue;
        }
        const next = raw[i + 1];
        i++;
        switch (next) {
            case "n":
                out += "\n";
                break;
            case "r":
                out += "\r";
                break;
            case "t":
                out += "\t";
                break;
            case "\\":
                out += "\\";
                break;
            case '"':
                out += '"';
                break;
            case "\n":
                // A backslash-newline is a line continuation: it swallows the
                // newline and nothing else. It does NOT strip the indentation on
                // the next line — verified against just 1.58.0, which reports
                // `"x\<newline>    indented"` as `x    indented`.
                break;
            case "u": {
                const m = /^\{([0-9a-fA-F]{1,6})\}/.exec(raw.slice(i + 1));
                if (m?.[1] !== undefined) {
                    out += String.fromCodePoint(Number.parseInt(m[1], 16));
                    i += m[0].length;
                } else {
                    out += "\\u";
                }
                break;
            }
            default:
                // Unknown escape: keep it verbatim rather than guessing. just
                // rejects these, and rejecting is Tier 2's job, not ours.
                out += `\\${next ?? EOF}`;
                break;
        }
    }
    return out;
}

interface Delimiter {
    readonly open: string;
    readonly style: StringStyle;
    readonly cooked: boolean;
    readonly kind: TokenKind;
}

/** Longest first, so triple delimiters win over single ones. */
const DELIMITERS: readonly Delimiter[] = [
    {
        open: "'''",
        style: StringStyle.TripleSingleRaw,
        cooked: false,
        kind: TokenKind.StringLiteral,
    },
    {
        open: '"""',
        style: StringStyle.TripleDoubleCooked,
        cooked: true,
        kind: TokenKind.StringLiteral,
    },
    { open: "```", style: StringStyle.TripleBacktick, cooked: false, kind: TokenKind.Backtick },
    { open: "'", style: StringStyle.SingleRaw, cooked: false, kind: TokenKind.StringLiteral },
    { open: '"', style: StringStyle.DoubleCooked, cooked: true, kind: TokenKind.StringLiteral },
    { open: "`", style: StringStyle.Backtick, cooked: false, kind: TokenKind.Backtick },
];

class Lexer {
    private readonly tokens: MutableToken[] = [];
    private readonly cursor: Cursor;

    /** Indent width of the recipe body we are inside, or null at the top level. */
    private bodyIndent: number | null = null;
    /** Set when the line just closed looked like a recipe header. */
    private expectBody = false;
    /** Indent width of the recipe header that opened the pending body. */
    private headerIndent = 0;

    constructor(source: string) {
        this.cursor = new Cursor(source);
    }

    tokenize(): Token[] {
        while (!this.cursor.atEnd) {
            this.lexLine();
        }
        if (this.bodyIndent !== null) {
            this.push(TokenKind.Dedent, this.cursor.mark(), "");
            this.bodyIndent = null;
        }
        this.push(TokenKind.Eof, this.cursor.mark(), "");
        return this.tokens as Token[];
    }

    private push(
        kind: TokenKind,
        start: { offset: number; line: number; column: number },
        text: string,
        extra?: Partial<MutableToken>,
    ): void {
        this.tokens.push({ kind, span: this.cursor.spanFrom(start), text, ...extra });
    }

    /** Consume horizontal whitespace, returning its width in characters. */
    private consumeIndent(): number {
        let width = 0;
        while (isHorizontalSpace(this.cursor.peek())) {
            this.cursor.advance();
            width++;
        }
        return width;
    }

    private isBlankRestOfLine(): boolean {
        let i = 0;
        while (isHorizontalSpace(this.cursor.peek(i))) {
            i++;
        }
        const c = this.cursor.peek(i);
        return c === "\n" || c === "\r" || c === EOF;
    }

    private lexLine(): void {
        const lineStart = this.cursor.mark();
        const indent = this.consumeIndent();

        // A blank line neither opens nor closes a recipe body.
        if (this.isBlankRestOfLine()) {
            this.consumeNewline(lineStart, indent);
            return;
        }

        if (this.bodyIndent === null && this.expectBody && indent > this.headerIndent) {
            this.bodyIndent = indent;
            this.expectBody = false;
            this.push(TokenKind.Indent, lineStart, this.cursor.slice(lineStart.offset));
            this.lexBodyLine();
            return;
        }

        if (this.bodyIndent !== null) {
            if (indent >= this.bodyIndent) {
                this.lexBodyLine();
                return;
            }
            this.push(TokenKind.Dedent, lineStart, "");
            this.bodyIndent = null;
        }

        this.expectBody = false;
        this.headerIndent = indent;
        this.lexTopLevelLine(indent);
    }

    private consumeNewline(
        start: { offset: number; line: number; column: number },
        _indent: number,
    ): void {
        while (isHorizontalSpace(this.cursor.peek())) {
            this.cursor.advance();
        }
        const nlStart = this.cursor.mark();
        if (this.cursor.peek() === "\r") {
            this.cursor.advance();
        }
        if (this.cursor.peek() === "\n") {
            this.cursor.advance();
        }
        if (this.cursor.pos > nlStart.offset) {
            this.push(TokenKind.Newline, nlStart, this.cursor.slice(nlStart.offset));
        }
        void start;
    }

    /** A recipe body line: opaque text, with `{{ ... }}` interpolations lexed as expressions. */
    private lexBodyLine(): void {
        let textStart = this.cursor.mark();
        let text = "";

        const flush = (): void => {
            if (text.length > 0) {
                this.tokens.push({
                    kind: TokenKind.Text,
                    span: {
                        offset: textStart.offset,
                        length: this.cursor.pos - textStart.offset,
                        line: textStart.line,
                        column: textStart.column,
                    },
                    text,
                });
                text = "";
            }
        };

        while (!this.cursor.atEnd) {
            const c = this.cursor.peek();
            if (c === "\n" || c === "\r") {
                break;
            }
            if (this.cursor.lookingAt("{{")) {
                flush();
                this.lexInterpolation();
                textStart = this.cursor.mark();
                continue;
            }
            // A backslash at end of line continues the command onto the next line.
            if (c === "\\" && (this.cursor.peek(1) === "\n" || this.cursor.peek(1) === "\r")) {
                text += c;
                this.cursor.advance();
                continue;
            }
            text += c;
            this.cursor.advance();
        }
        flush();
        this.consumeNewline(this.cursor.mark(), 0);
    }

    /** `{{` expression `}}`. Unterminated interpolations end at the newline. */
    private lexInterpolation(): void {
        const open = this.cursor.mark();
        this.cursor.advance(2);
        this.push(TokenKind.InterpolationStart, open, "{{");

        while (!this.cursor.atEnd) {
            const c = this.cursor.peek();
            if (c === "\n" || c === "\r") {
                return; // Unterminated. The parser recovers; we do not throw.
            }
            if (this.cursor.lookingAt("}}")) {
                const close = this.cursor.mark();
                this.cursor.advance(2);
                this.push(TokenKind.InterpolationEnd, close, "}}");
                return;
            }
            if (isHorizontalSpace(c)) {
                this.cursor.advance();
                continue;
            }
            this.lexAtom();
        }
    }

    private lexTopLevelLine(_indent: number): void {
        let sawColon = false;
        let sawColonEquals = false;

        while (!this.cursor.atEnd) {
            const c = this.cursor.peek();
            if (c === "\n" || c === "\r") {
                break;
            }
            if (isHorizontalSpace(c)) {
                this.cursor.advance();
                continue;
            }
            if (c === "#") {
                this.lexComment();
                continue;
            }
            const before = this.tokens.length;
            this.lexAtom();
            for (let i = before; i < this.tokens.length; i++) {
                const kind = this.tokens[i]?.kind;
                if (kind === TokenKind.Colon) {
                    sawColon = true;
                } else if (kind === TokenKind.ColonEquals) {
                    sawColonEquals = true;
                }
            }
        }

        // A line with a bare `:` is a recipe header, so the next more-indented
        // line opens a body. `:=` is assignment and opens nothing.
        this.expectBody = sawColon && !sawColonEquals;
        this.consumeNewline(this.cursor.mark(), 0);
    }

    private lexComment(): void {
        const start = this.cursor.mark();
        while (!this.cursor.atEnd) {
            const c = this.cursor.peek();
            if (c === "\n" || c === "\r") {
                break;
            }
            this.cursor.advance();
        }
        this.push(TokenKind.Comment, start, this.cursor.slice(start.offset));
    }

    /** One indivisible unit: identifier, literal, or operator. Always advances. */
    private lexAtom(): void {
        const start = this.cursor.mark();
        const c = this.cursor.peek();

        if (isIdentStart(c)) {
            while (isIdentContinue(this.cursor.peek())) {
                this.cursor.advance();
            }
            this.push(TokenKind.Identifier, start, this.cursor.slice(start.offset));
            return;
        }

        for (const delim of DELIMITERS) {
            if (this.cursor.lookingAt(delim.open)) {
                this.lexDelimited(start, delim);
                return;
            }
        }

        for (const [text, kind] of OPERATORS) {
            if (this.cursor.lookingAt(text)) {
                this.cursor.advance(text.length);
                this.push(kind, start, text);
                return;
            }
        }

        // Unrecognised. Consume exactly one character so we always make progress.
        this.cursor.advance();
        this.push(TokenKind.Unknown, start, this.cursor.slice(start.offset));
    }

    private lexDelimited(
        start: { offset: number; line: number; column: number },
        delim: Delimiter,
    ): void {
        this.cursor.advance(delim.open.length);
        const contentStart = this.cursor.pos;
        // Where the literal would end if we had to cut it short. See below.
        let firstNewline: { offset: number; line: number; column: number } | undefined;

        while (!this.cursor.atEnd) {
            // Only cooked literals honour backslash escapes.
            if (delim.cooked && this.cursor.peek() === "\\") {
                this.cursor.advance(); // the backslash
                // A backslash-newline is a line continuation, so the escape
                // consumes the newline. Note it as a recovery point anyway,
                // before stepping over it — otherwise a literal whose lines all
                // end in a backslash offers nowhere to rewind to, and recovery
                // lands further down the file than it should.
                if (firstNewline === undefined && this.cursor.peek() === "\n") {
                    firstNewline = this.cursor.mark();
                }
                this.cursor.advance(); // the escaped character
                continue;
            }
            if (this.cursor.lookingAt(delim.open)) {
                const raw = this.cursor.slice(contentStart);
                this.cursor.advance(delim.open.length);
                this.push(delim.kind, start, this.cursor.slice(start.offset), {
                    value: delim.cooked ? cook(raw) : raw,
                    style: delim.style,
                });
                return;
            }
            if (firstNewline === undefined && this.cursor.peek() === "\n") {
                firstNewline = this.cursor.mark();
            }
            this.cursor.advance();
        }

        // Ran to end of file without closing.
        //
        // Scanning across newlines above is correct, not a bug: `just` accepts
        // newlines inside both '...' and "..." and reports the value with the
        // newline intact. A literal that swallows the lines below it is what the
        // source actually means, and matching that beats a tidier-looking outline
        // that misrepresents the file.
        //
        // Reaching EOF is the one case where that reasoning does not apply. Such
        // a file is rejected by `just` outright, so no valid program can depend
        // on how we recover, and cutting the literal at its first newline lets
        // the rest of the file keep parsing. That is the common case in an
        // editor: someone has typed an opening quote and not yet closed it, and
        // they should not lose the outline for everything below while they type.
        if (firstNewline !== undefined && delim.open.length === 1) {
            this.cursor.reset(firstNewline);
        }
        this.push(delim.kind, start, this.cursor.slice(start.offset), {
            style: delim.style,
            unterminated: true,
        });
    }
}

export function tokenize(source: string): Token[] {
    return new Lexer(source).tokenize();
}

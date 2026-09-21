/**
 * Token definitions for the Justfile lexer.
 *
 * Tier 1 code: no VS Code API, no I/O, no subprocesses. See AGENTS.md.
 */

/**
 * Token kinds, as a frozen object plus a derived union.
 *
 * Not an enum: `erasableSyntaxOnly` forbids them, and a string union gives
 * better narrowing, readable values in test failures, and structural equality
 * with the JSON that `just --dump` produces.
 */
export const TokenKind = {
    // Structure
    Eof: "eof",
    Newline: "newline",
    Indent: "indent",
    Dedent: "dedent",
    Comment: "comment",

    // Atoms
    Identifier: "identifier",
    StringLiteral: "string",
    Backtick: "backtick",

    /** A run of literal text inside a recipe body line. */
    Text: "text",

    // Punctuation and operators
    ColonEquals: ":=",
    Colon: ":",
    Comma: ",",
    ParenL: "(",
    ParenR: ")",
    BracketL: "[",
    BracketR: "]",
    InterpolationStart: "{{",
    InterpolationEnd: "}}",
    At: "@",
    Dollar: "$",
    Asterisk: "*",
    Plus: "+",
    Slash: "/",
    Equals: "=",
    EqualsEquals: "==",
    BangEquals: "!=",
    EqualsTilde: "=~",
    AmpAmp: "&&",
    QuestionMark: "?",

    /** A byte sequence the lexer could not classify. Never fatal. */
    Unknown: "unknown",
} as const;

export type TokenKind = (typeof TokenKind)[keyof typeof TokenKind];

/** A half-open byte range into the source, plus a line/column for reporting. */
export interface Span {
    readonly offset: number;
    readonly length: number;
    /** Zero-based, to match VS Code's Position. */
    readonly line: number;
    /** Zero-based, in UTF-16 code units, to match VS Code's Position. */
    readonly column: number;
}

/** How a string or backtick literal was written. Affects escape handling. */
export const StringStyle = {
    /** `'...'` — no escape processing. */
    SingleRaw: "single-raw",
    /** `"..."` — escape sequences are processed. */
    DoubleCooked: "double-cooked",
    /** `'''...'''` — indented, no escape processing. */
    TripleSingleRaw: "triple-single-raw",
    /** `"""..."""` — indented, escapes processed. */
    TripleDoubleCooked: "triple-double-cooked",
    /** `` `...` `` — a command, which just evaluates at parse time. */
    Backtick: "backtick",
    /** An indented command, delimited by three backticks. */
    TripleBacktick: "triple-backtick",
} as const;

export type StringStyle = (typeof StringStyle)[keyof typeof StringStyle];

export interface Token {
    readonly kind: TokenKind;
    readonly span: Span;
    /** The exact source text this token covers, delimiters included. */
    readonly text: string;
    /**
     * For string and backtick tokens: the content with delimiters removed and
     * escapes resolved. Absent when the literal is unterminated.
     */
    readonly value?: string;
    /** Present on string and backtick tokens. */
    readonly style?: StringStyle;
    /** True when a literal ran to end of file without its closing delimiter. */
    readonly unterminated?: boolean;
}

export function isTrivia(kind: TokenKind): boolean {
    return kind === TokenKind.Comment || kind === TokenKind.Newline;
}

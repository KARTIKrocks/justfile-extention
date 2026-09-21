/**
 * Recursive-descent parser for Justfiles.
 *
 * Tier 1: no VS Code API, no I/O, no subprocesses. See AGENTS.md.
 *
 * Like the lexer, this is total. `parse` accepts any string and always returns
 * a `Justfile`. It never throws and never returns null. When input does not
 * match, it records a syntax error, skips to the next synchronisation point,
 * and carries on — so half a Justfile still produces an outline, and someone
 * typing a recipe one character at a time still gets navigation.
 *
 * The errors it records are strictly syntactic. Anything semantic — unknown
 * attributes, undefined variables, dependencies on recipes that do not exist —
 * is deliberately absent, because `just` is the only authority on those.
 */

import type {
    Alias,
    Assignment,
    Attribute,
    AttributeArgument,
    BodyFragment,
    BodyLine,
    Dependency,
    Expression,
    Import,
    Item,
    Justfile,
    ModuleDeclaration,
    Name,
    Parameter,
    ParameterKind,
    ParseError,
    Recipe,
    Setting,
    StringExpression,
} from "./ast.js";
import { tokenize } from "./lexer.js";
import { type Span, StringStyle, type Token, TokenKind } from "./token.js";

const EMPTY_SPAN: Span = { offset: 0, length: 0, line: 0, column: 0 };

/**
 * Cap on expression nesting, to keep the recursive descent off the call stack
 * limit. Hand-written Justfiles nest a handful of levels deep at most; this is
 * far above anything real and far below where Node overflows.
 */
const MAX_EXPRESSION_DEPTH = 128;

type ComparisonOperator = "==" | "!=" | "=~";

/**
 * One `if`/`else if` clause, collected before the chain is folded into nested
 * conditional nodes. Fields are explicitly `| undefined` rather than optional
 * so they can be assigned unconditionally under `exactOptionalPropertyTypes`.
 */
interface ConditionalClause {
    readonly start: Span;
    readonly left: Expression | undefined;
    readonly operator: ComparisonOperator | undefined;
    readonly right: Expression | undefined;
    readonly consequent: Expression | undefined;
}

/** Keywords that introduce an item. Not reserved words — `set` can be a recipe name. */
const KEYWORD = {
    set: "set",
    alias: "alias",
    export: "export",
    unexport: "unexport",
    import: "import",
    mod: "mod",
    if: "if",
    else: "else",
} as const;

function spanBetween(from: Span, to: Span): Span {
    return {
        offset: from.offset,
        length: Math.max(0, to.offset + to.length - from.offset),
        line: from.line,
        column: from.column,
    };
}

class Parser {
    private readonly tokens: readonly Token[];
    private readonly errors: ParseError[] = [];
    private index = 0;
    /** Current expression nesting depth, bounded by MAX_EXPRESSION_DEPTH. */
    private depth = 0;
    /**
     * How many `(` — group or call — we are lexically inside. `just` treats a
     * newline as insignificant once inside an unmatched paren, no matter how
     * deep, so this has to be a counter rather than a flag: it is what tells
     * `parseUnary`/`parseConcat`/`parseJoin` — shared with top-level parsing,
     * where a newline ends the expression — that they are in that context.
     */
    private parenDepth = 0;
    /** Comment lines seen since the last item, used for doc comments. */
    private pendingDoc: string[] = [];

    constructor(tokens: readonly Token[]) {
        this.tokens = tokens;
    }

    // -- token access -------------------------------------------------------

    private peek(offset = 0): Token {
        return this.tokens[this.index + offset] ?? this.eofToken();
    }

    private eofToken(): Token {
        const last = this.tokens.at(-1);
        return last ?? { kind: TokenKind.Eof, span: EMPTY_SPAN, text: "" };
    }

    private get done(): boolean {
        return this.peek().kind === TokenKind.Eof;
    }

    private at(kind: TokenKind): boolean {
        return this.peek().kind === kind;
    }

    /**
     * The span from `from` through the last token actually consumed.
     *
     * `spanBetween(from, this.peek().span)` reads naturally and is wrong: peek
     * is the next *unconsumed* token, so the span swallows the first token of
     * whatever follows. A recipe then covers the name of the recipe below it,
     * every construct's range overlaps its neighbour's, and anything that asks
     * "what is at this position" can get the wrong answer.
     *
     * Zero-width tokens and trailing newlines are skipped, so a span ends on
     * real text. Clicking a one-line item in the outline should not select
     * through the line break into the next line.
     *
     * The scan stops at `from`: a production that consumed nothing would
     * otherwise land on a token *before* its own start and collapse to length
     * zero, and a node with no width cannot be highlighted or pointed at.
     */
    private spanThrough(from: Span): Span {
        for (let i = this.index - 1; i >= 0; i--) {
            const token = this.tokens[i];
            if (token === undefined) {
                continue;
            }
            if (token.span.offset < from.offset) {
                break;
            }
            if (token.span.length > 0 && token.kind !== TokenKind.Newline) {
                return spanBetween(from, token.span);
            }
        }
        return from;
    }

    private atKeyword(word: string): boolean {
        const token = this.peek();
        return token.kind === TokenKind.Identifier && token.text === word;
    }

    private advance(): Token {
        const token = this.peek();
        if (token.kind !== TokenKind.Eof) {
            this.index++;
        }
        return token;
    }

    private eat(kind: TokenKind): Token | undefined {
        return this.at(kind) ? this.advance() : undefined;
    }

    /** Consume `kind`, or record an error and return undefined. Never throws. */
    private expect(kind: TokenKind, what: string): Token | undefined {
        const token = this.eat(kind);
        if (token === undefined) {
            this.error(`expected ${what}`, this.peek().span);
        }
        return token;
    }

    private error(message: string, span: Span): void {
        // Cap the error list: a pathological file must not turn into millions
        // of diagnostics, and after the first few they stop being useful.
        if (this.errors.length < 100) {
            this.errors.push({ message, span });
        }
    }

    private skipNewlines(): void {
        while (this.at(TokenKind.Newline)) {
            this.advance();
        }
    }

    /**
     * Skip newlines only when lexically inside an unmatched `(` — a group or
     * a call's arguments — where `just` treats them as insignificant. At the
     * top level a newline still ends the expression (it is what lets
     * `parseAssignment` and friends find the end of a value), so this must
     * stay conditional on `parenDepth` rather than becoming the default.
     */
    private skipNewlinesInGroup(): void {
        if (this.parenDepth > 0) {
            this.skipNewlines();
        }
    }

    /** Skip to the start of the next line. The main recovery point. */
    private recoverToNextLine(): void {
        while (!this.done && !this.at(TokenKind.Newline)) {
            this.advance();
        }
        this.skipNewlines();
    }

    /**
     * End-of-item recovery, skipped when the parser already stopped at the next
     * item.
     *
     * An item whose value spans lines — an unclosed multi-line list is how that
     * happens — can finish with the parser sitting on the item below it.
     * Skipping to the next line from there would discard a line that parses
     * perfectly well, so one missing `]` would cost two items instead of one.
     */
    private recoverToNextItem(): void {
        if (!this.atItemStart()) {
            this.recoverToNextLine();
        }
    }

    // -- entry point --------------------------------------------------------

    parse(): Justfile {
        const items: Item[] = [];
        const start = this.peek().span;

        while (!this.done) {
            const before = this.index;
            const item = this.parseItem();
            if (item !== undefined) {
                items.push(item);
            }
            // Guarantee progress. Without this, any bug in a parse method turns
            // into a hang, which is far worse than a wrong parse.
            if (this.index === before) {
                this.advance();
            }
        }

        return {
            kind: "justfile",
            span: spanBetween(start, this.eofToken().span),
            items,
            errors: this.errors,
        };
    }

    private parseItem(): Item | undefined {
        if (this.skipTrivia()) {
            return undefined;
        }
        const attributes = this.at(TokenKind.BracketL) ? this.parseAttributes() : [];
        return this.parseItemBody(attributes);
    }

    /**
     * Consume anything that is not itself an item: blank lines, comments, and
     * indentation that appears outside a recipe body. Returns true if it
     * consumed something, meaning there is no item to parse here.
     */
    private skipTrivia(): boolean {
        if (this.at(TokenKind.Newline)) {
            this.advance();
            this.pendingDoc = [];
            return true;
        }
        if (this.at(TokenKind.Comment)) {
            const comment = this.advance();
            this.pendingDoc.push(comment.text.replace(/^#+\s?/, ""));
            // Consume the newline here rather than letting the branch above see
            // it, which would clear the doc we just collected. Only a *blank*
            // line separates a comment from the item it documents.
            this.eat(TokenKind.Newline);
            return true;
        }
        // Stray indentation outside a recipe body. Skip the whole block rather
        // than trying to interpret it, so one bad indent does not derail the file.
        if (this.at(TokenKind.Indent)) {
            this.advance();
            while (!this.done && !this.at(TokenKind.Dedent)) {
                this.advance();
            }
            this.eat(TokenKind.Dedent);
            return true;
        }
        if (this.at(TokenKind.Dedent)) {
            this.advance();
            return true;
        }
        return false;
    }

    private parseItemBody(attributes: readonly Attribute[]): Item {
        // None of these words is reserved, so the shape of the line decides and
        // not the word it starts with: `import:` is a recipe named "import",
        // and `mod p:` a recipe named "mod" that takes a parameter. A recipe
        // header therefore wins over every keyword below.
        if (!this.atRecipeHeader()) {
            if (this.atKeyword(KEYWORD.set) && this.isItemKeyword()) {
                return this.parseSetting();
            }
            if (this.atKeyword(KEYWORD.alias) && this.isItemKeyword()) {
                return this.parseAlias();
            }
            if (this.atKeyword(KEYWORD.import)) {
                return this.parseImport();
            }
            if (this.atModuleKeyword()) {
                return this.parseModule(attributes);
            }
        }
        if (this.atExportedAssignment()) {
            const keyword = this.advance();
            return this.parseAssignment(keyword.text === KEYWORD.export, keyword.span);
        }
        if (this.isAssignmentAhead(0)) {
            return this.parseAssignment(false);
        }
        if (this.at(TokenKind.Identifier) || this.at(TokenKind.At)) {
            return this.parseRecipe(attributes);
        }

        const token = this.peek();
        this.error("expected a recipe, assignment, alias, setting, import or module", token.span);
        const text = token.text;
        this.recoverToNextLine();
        return { kind: "error-item", span: token.span, text };
    }

    private atExportedAssignment(): boolean {
        const isExportWord = this.atKeyword(KEYWORD.export) || this.atKeyword(KEYWORD.unexport);
        return isExportWord && this.isAssignmentAhead(1);
    }

    /** Only treat `set` or `alias` as a keyword when a name follows it. */
    private isItemKeyword(): boolean {
        return this.peek(1).kind === TokenKind.Identifier;
    }

    /**
     * Is this `mod` the module keyword rather than a name spelled "mod"?
     *
     * The `?` of an optional module needs no space around it — `mod?sub` is
     * what `just` accepts, because `?` cannot appear in a name — so looking
     * only at the next token misses every optional module and reads it as a
     * recipe called "mod".
     */
    private atModuleKeyword(): boolean {
        if (!this.atKeyword(KEYWORD.mod)) {
            return false;
        }
        const nameOffset = this.peek(1).kind === TokenKind.QuestionMark ? 2 : 1;
        return this.peek(nameOffset).kind === TokenKind.Identifier;
    }

    /** Is there a `:=` on this line, making it an assignment rather than a recipe? */
    private isAssignmentAhead(offset: number): boolean {
        if (this.peek(offset).kind !== TokenKind.Identifier) {
            return false;
        }
        return this.peek(offset + 1).kind === TokenKind.ColonEquals;
    }

    // -- items --------------------------------------------------------------

    private parseName(): Name {
        const token = this.peek();
        if (token.kind === TokenKind.Identifier) {
            this.advance();
            return { kind: "name", span: token.span, text: token.text };
        }
        this.error("expected a name", token.span);
        return { kind: "name", span: token.span, text: "" };
    }

    private parseSetting(): Setting {
        const start = this.advance().span; // `set`
        const name = this.parseName();
        let value: Expression | undefined;
        if (this.eat(TokenKind.ColonEquals) !== undefined) {
            value = this.parseExpression();
        }
        // After recovery, not before, so the item covers its whole line even
        // when the value stopped parsing partway along it.
        this.recoverToNextItem();
        const span = this.spanThrough(start);
        return value === undefined
            ? { kind: "setting", span, name }
            : { kind: "setting", span, name, value };
    }

    private parseAlias(): Alias {
        const start = this.advance().span; // `alias`
        const name = this.parseName();
        let target: Name | undefined;
        if (this.expect(TokenKind.ColonEquals, "`:=`") !== undefined) {
            target = this.parseName();
        }
        this.recoverToNextLine();
        const span = this.spanThrough(start);
        return target === undefined
            ? { kind: "alias", span, name }
            : { kind: "alias", span, name, target };
    }

    /**
     * `start` is the `export` or `unexport` keyword when there was one, so the
     * item covers the whole statement rather than beginning at its name.
     */
    private parseAssignment(exported: boolean, start?: Span): Assignment {
        const name = this.parseName();
        this.expect(TokenKind.ColonEquals, "`:=`");
        const value = this.parseExpression();
        this.recoverToNextItem();
        return {
            kind: "assignment",
            span: this.spanThrough(start ?? name.span),
            name,
            exported,
            value,
        };
    }

    private parseImport(): Import {
        const start = this.advance().span; // `import`
        const optional = this.eat(TokenKind.QuestionMark) !== undefined;
        const path = this.at(TokenKind.StringLiteral) ? this.parseStringExpression() : undefined;
        if (path === undefined) {
            this.error("expected a quoted path after `import`", this.peek().span);
        }
        this.recoverToNextLine();
        const span = this.spanThrough(start);
        return path === undefined
            ? { kind: "import", span, optional }
            : { kind: "import", span, optional, path };
    }

    private parseModule(attributes: readonly Attribute[]): ModuleDeclaration {
        const start = this.advance().span; // `mod`
        const optional = this.eat(TokenKind.QuestionMark) !== undefined;
        const name = this.parseName();
        const path = this.at(TokenKind.StringLiteral) ? this.parseStringExpression() : undefined;
        const doc = this.takeDoc();
        const end = this.peek().span;
        this.recoverToNextLine();
        const base = {
            kind: "module",
            span: spanBetween(start, end),
            name,
            optional,
            attributes,
        } as const;
        if (path !== undefined && doc !== undefined) {
            return { ...base, path, doc };
        }
        if (path !== undefined) {
            return { ...base, path };
        }
        if (doc !== undefined) {
            return { ...base, doc };
        }
        return base;
    }

    /**
     * The doc comment for the item about to be parsed.
     *
     * just takes only the *last* comment line above an item, not the whole
     * block — verified against `--dump`, which reports "Second line" for a
     * two-line comment. Joining the lines instead would put text in hovers that
     * `just --list` never shows.
     */
    private takeDoc(): string | undefined {
        const doc = this.pendingDoc.at(-1);
        this.pendingDoc = [];
        return doc;
    }

    // -- attributes ---------------------------------------------------------

    private parseAttributes(): Attribute[] {
        const attributes: Attribute[] = [];
        while (this.at(TokenKind.BracketL)) {
            const start = this.advance().span;
            // A single bracket group may hold several comma-separated attributes.
            do {
                attributes.push(this.parseAttribute(start));
            } while (this.eat(TokenKind.Comma) !== undefined);
            this.expect(TokenKind.BracketR, "`]`");
            this.skipNewlines();
            // Comments may sit between attributes and the recipe they decorate.
            while (this.at(TokenKind.Comment)) {
                this.pendingDoc.push(this.advance().text.replace(/^#+\s?/, ""));
                this.skipNewlines();
            }
        }
        return attributes;
    }

    /** One attribute inside a bracket group: `name` or `name('arg', 'arg')`. */
    private parseAttribute(start: Span): Attribute {
        const name = this.parseName();
        const args: AttributeArgument[] = [];
        if (this.eat(TokenKind.ParenL) !== undefined) {
            while (!this.done && !this.at(TokenKind.ParenR) && !this.at(TokenKind.Newline)) {
                const token = this.advance();
                if (token.kind === TokenKind.StringLiteral) {
                    args.push({
                        kind: "attribute-argument",
                        span: token.span,
                        value: token.value ?? "",
                    });
                } else if (token.kind !== TokenKind.Comma) {
                    this.error("expected a quoted attribute argument", token.span);
                }
            }
            this.expect(TokenKind.ParenR, "`)`");
        }
        return {
            kind: "attribute",
            span: this.spanThrough(start),
            name,
            args,
        };
    }

    // -- recipes ------------------------------------------------------------

    private parseRecipe(attributes: readonly Attribute[]): Recipe {
        const startToken = this.peek();
        const quiet = this.eat(TokenKind.At) !== undefined;
        const name = this.parseName();
        const doc = this.takeDoc();

        const parameters: Parameter[] = [];
        while (!this.done && !this.at(TokenKind.Colon) && !this.at(TokenKind.Newline)) {
            const before = this.index;
            parameters.push(this.parseParameter());
            if (this.index === before) {
                this.advance();
            }
        }

        this.expect(TokenKind.Colon, "`:` after the recipe name");

        const dependencies: Dependency[] = [];
        const subsequents: Dependency[] = [];
        let target = dependencies;
        while (!this.done && !this.at(TokenKind.Newline)) {
            if (this.eat(TokenKind.AmpAmp) !== undefined) {
                target = subsequents;
                continue;
            }
            const dependency = this.parseDependency();
            if (dependency === undefined) {
                break;
            }
            target.push(dependency);
        }
        this.skipNewlines();

        const body = this.at(TokenKind.Indent) ? this.parseBody() : [];
        const shebang = bodyHasShebang(body);

        const base = {
            kind: "recipe",
            span: this.spanThrough(startToken.span),
            name,
            attributes,
            parameters,
            dependencies,
            subsequents,
            body,
            quiet,
            shebang,
        } as const;
        return doc === undefined ? base : { ...base, doc };
    }

    private parseParameter(): Parameter {
        const start = this.peek().span;
        let parameterKind: ParameterKind = "singular";
        if (this.eat(TokenKind.Plus) !== undefined) {
            parameterKind = "plus";
        } else if (this.eat(TokenKind.Asterisk) !== undefined) {
            parameterKind = "star";
        }
        const exported = this.eat(TokenKind.Dollar) !== undefined;
        const name = this.parseName();
        let defaultValue: Expression | undefined;
        if (this.eat(TokenKind.Equals) !== undefined) {
            defaultValue = this.parseExpression();
        }
        const span = this.spanThrough(start);
        return defaultValue === undefined
            ? { kind: "parameter", span, name, parameterKind, exported }
            : { kind: "parameter", span, name, parameterKind, exported, default: defaultValue };
    }

    private parseDependency(): Dependency | undefined {
        if (this.at(TokenKind.ParenL)) {
            const start = this.advance().span;
            const name = this.parseName();
            const args: Expression[] = [];
            while (!this.done && !this.at(TokenKind.ParenR) && !this.at(TokenKind.Newline)) {
                const before = this.index;
                args.push(this.parseExpression());
                if (this.index === before) {
                    this.advance();
                }
            }
            this.expect(TokenKind.ParenR, "`)`");
            return {
                kind: "dependency",
                span: this.spanThrough(start),
                name,
                args,
            };
        }
        if (this.at(TokenKind.Identifier)) {
            const name = this.parseName();
            return { kind: "dependency", span: name.span, name, args: [] };
        }
        this.error("expected a dependency", this.peek().span);
        this.recoverToNextLine();
        return undefined;
    }

    private parseBody(): BodyLine[] {
        this.advance(); // Indent
        const lines: BodyLine[] = [];
        let fragments: BodyFragment[] = [];
        let lineStart = this.peek().span;

        const endLine = (end: Span): void => {
            if (fragments.length > 0) {
                lines.push({
                    kind: "body-line",
                    span: spanBetween(lineStart, end),
                    fragments,
                });
                fragments = [];
            }
        };

        while (!this.done && !this.at(TokenKind.Dedent)) {
            const token = this.peek();
            if (token.kind === TokenKind.Newline) {
                this.advance();
                endLine(token.span);
                lineStart = this.peek().span;
                continue;
            }
            if (token.kind === TokenKind.Text) {
                this.advance();
                fragments.push({ kind: "text", span: token.span, text: token.text });
                continue;
            }
            if (token.kind === TokenKind.InterpolationStart) {
                fragments.push(this.parseInterpolation());
                continue;
            }
            // Anything else inside a body is shell text the lexer split up.
            this.advance();
            fragments.push({ kind: "text", span: token.span, text: token.text });
        }
        endLine(this.peek().span);
        this.eat(TokenKind.Dedent);
        return lines;
    }

    private parseInterpolation(): BodyFragment {
        const start = this.advance().span; // `{{`
        const expression = this.at(TokenKind.InterpolationEnd) ? undefined : this.parseExpression();
        const closed = this.eat(TokenKind.InterpolationEnd) !== undefined;
        if (!closed) {
            this.error("unterminated `{{`", start);
        }
        const span = this.spanThrough(start);
        return expression === undefined
            ? { kind: "interpolation", span, unterminated: !closed }
            : { kind: "interpolation", span, expression, unterminated: !closed };
    }

    // -- expressions --------------------------------------------------------

    /**
     * Every recursive path through the expression grammar passes through here —
     * conditionals, brace blocks, parenthesised groups, call arguments — so
     * bounding this one function bounds the whole descent.
     *
     * Without the bound, a deeply nested expression exhausts the JavaScript call
     * stack and the `RangeError` escapes, breaking the promise that `parse`
     * returns a `Justfile` for any input. A file nested past this limit is not
     * something a person wrote by hand, and `just` itself rejects it, so cutting
     * the expression off costs nothing real and keeps the parser total.
     */
    private parseExpression(): Expression {
        if (this.depth >= MAX_EXPRESSION_DEPTH) {
            const token = this.peek();
            this.error("expression nested too deeply", token.span);
            // Consume one token so callers cannot spin here.
            this.advance();
            return { kind: "error-expression", span: token.span };
        }
        this.depth++;
        try {
            if (this.atKeyword(KEYWORD.if)) {
                return this.parseConditional();
            }
            return this.parseConcat();
        } finally {
            this.depth--;
        }
    }

    /**
     * `if a == b { x } else if c == d { y } else { z }`, parsed as a flat chain.
     *
     * The chain is iterative rather than recursive because `else if` is not
     * nesting — it is a sequence. Recursing once per clause grew the stack with
     * the length of the chain, and a 20,000-clause chain exhausted it, letting a
     * `RangeError` escape `parse`.
     *
     * Routing each clause back through `parseExpression` would fix the crash but
     * spend the shared depth budget per clause, so a chain longer than
     * MAX_EXPRESSION_DEPTH would be cut short and reported as a syntax error.
     * `just` 1.58.0 accepts a 300-clause chain, so that would be a squiggle on a
     * file `just` runs happily — the one failure mode this parser must not have.
     *
     * A loop has neither problem: no stack growth, and no limit on a construct
     * the oracle accepts. Genuine nesting, via the brace blocks, still recurses
     * through `parseExpression` and is still bounded there.
     */
    private parseConditional(): Expression {
        const clauses: ConditionalClause[] = [];
        let alternative: Expression | undefined;

        for (;;) {
            const start = this.advance().span; // `if`
            const left = this.parseConcat();

            let operator: ComparisonOperator | undefined;
            if (this.eat(TokenKind.EqualsEquals) !== undefined) {
                operator = "==";
            } else if (this.eat(TokenKind.BangEquals) !== undefined) {
                operator = "!=";
            } else if (this.eat(TokenKind.EqualsTilde) !== undefined) {
                operator = "=~";
            } else {
                this.error("expected `==`, `!=` or `=~`", this.peek().span);
            }

            const right = operator === undefined ? undefined : this.parseConcat();
            const consequent = this.parseBraceBlock();
            clauses.push({ start, left, operator, right, consequent });

            if (!this.atKeyword(KEYWORD.else)) {
                break;
            }
            this.advance(); // `else`
            if (this.atKeyword(KEYWORD.if)) {
                continue; // another clause in the same chain
            }
            alternative = this.parseBraceBlock();
            break;
        }

        // Fold right to left, so each clause's `alternative` is the rest of the
        // chain. Every clause ends where the chain ends, which is what the
        // previous recursive form produced too.
        const end = this.peek().span;
        let result: Expression | undefined = alternative;
        for (let i = clauses.length - 1; i >= 0; i--) {
            const clause = clauses[i];
            if (clause === undefined) {
                continue;
            }
            result = {
                kind: "conditional",
                span: spanBetween(clause.start, end),
                ...(clause.left !== undefined && { left: clause.left }),
                ...(clause.operator !== undefined && { operator: clause.operator }),
                ...(clause.right !== undefined && { right: clause.right }),
                ...(clause.consequent !== undefined && { consequent: clause.consequent }),
                ...(result !== undefined && { alternative: result }),
            };
        }
        return result ?? { kind: "error-expression", span: end };
    }

    /**
     * `{ expr }`. The lexer produces `{{` for a doubled brace, so a block that
     * opens immediately with a nested brace arrives as one token; treat that as
     * a single `{` and let the matching `}}` close both.
     */
    private parseBraceBlock(): Expression | undefined {
        if (this.eat(TokenKind.InterpolationStart) === undefined) {
            const token = this.peek();
            if (token.kind === TokenKind.Unknown && token.text === "{") {
                this.advance();
            } else {
                this.error("expected `{`", token.span);
                return undefined;
            }
        }
        const inner = this.parseExpression();
        if (this.eat(TokenKind.InterpolationEnd) === undefined) {
            const token = this.peek();
            if (token.kind === TokenKind.Unknown && token.text === "}") {
                this.advance();
            } else {
                this.error("expected `}`", token.span);
            }
        }
        return inner;
    }

    private parseConcat(): Expression {
        let left = this.parseJoin();
        this.skipNewlinesInGroup();
        while (this.at(TokenKind.Plus)) {
            this.advance();
            const right = this.parseJoin();
            left = {
                kind: "concat",
                span: spanBetween(left.span, right.span),
                left,
                right,
            };
            this.skipNewlinesInGroup();
        }
        return left;
    }

    private parseJoin(): Expression {
        this.skipNewlinesInGroup();
        // `/ path` is a valid absolute join with no left operand.
        if (this.at(TokenKind.Slash)) {
            const start = this.advance().span;
            const right = this.parseUnary();
            return { kind: "join", span: spanBetween(start, right.span), right };
        }
        let left = this.parseUnary();
        this.skipNewlinesInGroup();
        while (this.at(TokenKind.Slash)) {
            this.advance();
            const right = this.parseUnary();
            left = { kind: "join", span: spanBetween(left.span, right.span), left, right };
            this.skipNewlinesInGroup();
        }
        return left;
    }

    private parseUnary(): Expression {
        this.skipNewlinesInGroup();
        const token = this.peek();

        if (token.kind === TokenKind.StringLiteral) {
            return this.parseStringExpression();
        }

        if (token.kind === TokenKind.Backtick) {
            this.advance();
            return {
                kind: "backtick",
                span: token.span,
                command: token.value ?? "",
                unterminated: token.unterminated === true,
            };
        }

        if (token.kind === TokenKind.ParenL) {
            this.advance();
            this.parenDepth++;
            // Always an expression, never `at(ParenR)` short-circuited to an
            // empty group: `just` requires one inside `(...)` and rejects
            // `()` outright, so treating it as valid here would be a missing
            // squiggle on code just doesn't accept. Calling `parseExpression`
            // unconditionally reports that itself — its own "expected an
            // expression" on a token that is immediately `)` — and still
            // never throws, since parseExpression always returns some node.
            let inner: Expression;
            try {
                inner = this.parseExpression();
            } finally {
                this.parenDepth--;
            }
            this.expect(TokenKind.ParenR, "`)`");
            const span = this.spanThrough(token.span);
            return { kind: "group", span, inner };
        }

        if (token.kind === TokenKind.BracketL) {
            this.advance();
            const elements = this.parseCommaSeparated(TokenKind.BracketR);
            return { kind: "list", span: this.spanThrough(token.span), elements };
        }

        if (token.kind === TokenKind.Identifier) {
            const name = this.parseName();
            if (!this.at(TokenKind.ParenL)) {
                return { kind: "variable", span: name.span, name };
            }
            this.advance();
            this.parenDepth++;
            let args: Expression[];
            try {
                args = this.parseCommaSeparated(TokenKind.ParenR);
            } finally {
                this.parenDepth--;
            }
            return {
                kind: "call",
                span: this.spanThrough(name.span),
                callee: name,
                args,
            };
        }

        this.error("expected an expression", token.span);
        return { kind: "error-expression", span: token.span };
    }

    /**
     * Elements or arguments up to `closing` — `]` for a list literal, `)`
     * for a call. Always terminates. Shared because the two are the same
     * grammar: comma-separated expressions where a newline carries no
     * meaning, `just` accepts either split over as many lines as it takes,
     * and both need the same bound against an unclosed bracket swallowing
     * every recipe below it.
     *
     * `atUnambiguousItemStart` is that bound for everything except a
     * `[Identifier` element, which is also the shape of an attribute for the
     * item below (`[private]`) and cannot be told apart from a nested list
     * by looking at it alone — both are valid at that point, so bailing out
     * unconditionally would put a syntax error on code like
     * `foo([private])`, which `just` accepts. It is instead parsed
     * optimistically as an element, and only reinterpreted as an attribute
     * in hindsight — by backtracking to `before` and stopping — if nothing
     * turns out to continue the sequence afterward: no comma, and not
     * `closing` either.
     */
    private parseCommaSeparated(closing: TokenKind): Expression[] {
        const elements: Expression[] = [];
        for (;;) {
            this.skipNewlines();
            if (this.done || this.at(closing) || this.atUnambiguousItemStart()) {
                break;
            }
            const before = this.index;
            const guessedAttribute = this.looksLikeAttribute();
            const element = this.parseExpression();
            this.skipNewlines();
            const hadComma = this.eat(TokenKind.Comma) !== undefined;
            if (guessedAttribute && !hadComma && !this.done && !this.at(closing)) {
                this.index = before;
                break;
            }
            elements.push(element);
            // Progress is guaranteed by the skips above in every case but one:
            // an element that consumed nothing with no newline and no comma
            // after it. Force it, so a stray token cannot spin here.
            if (this.index === before) {
                this.advance();
            }
        }
        this.expect(closing, closing === TokenKind.BracketR ? "`]`" : "`)`");
        return elements;
    }

    /**
     * Does the parser sit at the start of a line that can only be a new item?
     *
     * Recovery inside a bracketed expression needs somewhere to stop, and the
     * next item is the only honest place: everything after it parses correctly
     * whatever went wrong above. The test mirrors the bail-out lookahead in the
     * TextMate grammar, and is deliberately conservative — a line that merely
     * *could* be an expression, such as a bare string, keeps the list open.
     *
     * Column zero is required because `just` allows a list's elements to sit at
     * any indentation, including none; the keyword or `name:` shape is what
     * separates a continuation line from an item, not the indent alone.
     */
    private atItemStart(): boolean {
        return this.looksLikeAttribute() || this.atUnambiguousItemStart();
    }

    /**
     * Is the current token a `[Identifier` at column 0 — the shape of an
     * attribute for the item below, e.g. `[private]`?
     *
     * A name has to follow the bracket, which is what the grammar's bail-out
     * requires too: every attribute starts with one, so `[` before anything
     * else is a nested list and not an item.
     *
     * This alone is never enough to call it an item boundary, though:
     * `[Identifier...]` is equally valid syntax for a nested list literal, so
     * `foo([private])` is a call whose only argument is a one-element list,
     * and bailing out on sight would put a syntax error on code `just`
     * accepts cleanly. It is still a useful guess once nothing turns out to
     * continue afterward — see `parseCommaSeparated`, which backtracks over
     * exactly this case — and `atItemStart`, consulted only once a value has
     * already failed to parse, where the guess is the best available answer.
     */
    private looksLikeAttribute(): boolean {
        return (
            this.peek().span.column === 0 &&
            this.at(TokenKind.BracketL) &&
            this.peek(1).kind === TokenKind.Identifier
        );
    }

    /**
     * `atItemStart`'s checks other than the attribute-shaped bracket guess.
     * None of a recipe header, `set`, `mod`, `import`, `alias` or an
     * assignment can ever be valid element or argument syntax — a bare `:`
     * or `:=` at column 0 has no place in an expression — so unlike the
     * bracket case, `parseCommaSeparated` can bail on these the moment it
     * sees them, with no need to attempt a parse and backtrack first.
     */
    private atUnambiguousItemStart(): boolean {
        if (this.peek().span.column !== 0) {
            return false;
        }
        if (this.atRecipeHeader() || this.atModuleKeyword()) {
            return true;
        }
        if (this.atKeyword(KEYWORD.import)) {
            return true;
        }
        const isItemWord = this.atKeyword(KEYWORD.set) || this.atKeyword(KEYWORD.alias);
        if (isItemWord && this.isItemKeyword()) {
            return true;
        }
        return this.atExportedAssignment() || this.isAssignmentAhead(0);
    }

    /** Is this line a recipe header — a name, then a `:` before the newline? */
    private atRecipeHeader(): boolean {
        if (!this.at(TokenKind.Identifier) && !this.at(TokenKind.At)) {
            return false;
        }
        // Bounded by the stream length, not by finding an Eof: `peek` past the
        // end repeats the last token, so a forward scan that trusts Eof to
        // arrive is a scan that can run forever.
        for (let offset = 0; this.index + offset < this.tokens.length; offset++) {
            const kind = this.peek(offset).kind;
            if (kind === TokenKind.Newline || kind === TokenKind.Eof) {
                return false;
            }
            if (kind === TokenKind.Colon) {
                return true;
            }
        }
        return false;
    }

    private parseStringExpression(): StringExpression {
        const token = this.advance();
        const unterminated = token.unterminated === true;
        const style = token.style ?? StringStyle.DoubleCooked;
        return token.value === undefined
            ? { kind: "string", span: token.span, style, unterminated }
            : { kind: "string", span: token.span, style, value: token.value, unterminated };
    }
}

function bodyHasShebang(body: readonly BodyLine[]): boolean {
    const first = body[0]?.fragments[0];
    return first?.kind === "text" && first.text.startsWith("#!");
}

export function parse(source: string): Justfile {
    return new Parser(tokenize(source)).parse();
}

export function parseTokens(tokens: readonly Token[]): Justfile {
    return new Parser(tokens).parse();
}

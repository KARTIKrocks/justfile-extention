/**
 * Folding ranges, computed from the syntax tree and, for comment blocks, the
 * token stream.
 *
 * Tier 1: no VS Code API, no I/O, no subprocesses. See AGENTS.md. The provider
 * layer turns what this returns into `vscode.FoldingRange`; keeping the
 * decisions here means they are testable in plain Node.
 *
 * Candidates are offset ranges, not line ranges. A `vscode.FoldingRange` is a
 * pair of line numbers, but turning an offset into a line needs the document,
 * which this layer does not have — see `src/outline/symbols.ts`, whose
 * `OffsetRange` this reuses for exactly that reason. That also means a
 * candidate here is not yet known to span more than one line: `(a)` and
 * `(\n    a\n)` produce the same shape of node, and only the provider,
 * converting to lines, can tell them apart. It drops anything that turns out
 * not to.
 */

import { type OffsetRange, rangeOf } from "../outline/symbols.js";
import type { Dependency, Expression, Item, Justfile, Parameter, Recipe } from "../parser/ast.js";
import type { Span, Token } from "../parser/token.js";
import { TokenKind } from "../parser/token.js";

/**
 * Kinds VS Code gives special handling — "Fold All Comments" acts only on
 * `Comment`. Everything else is left without a kind, which is the ordinary,
 * unclassified fold VS Code already offers a "Fold All" for.
 */
export const FoldingKind = {
    Comment: "comment",
} as const;

export type FoldingKind = (typeof FoldingKind)[keyof typeof FoldingKind];

export interface FoldingRange {
    readonly range: OffsetRange;
    readonly kind?: FoldingKind;
}

function add(ranges: FoldingRange[], span: Span, kind?: FoldingKind): void {
    ranges.push(kind === undefined ? { range: rangeOf(span) } : { range: rangeOf(span), kind });
}

/**
 * Expression kinds capable of spanning more than one line: a bracketed list,
 * a parenthesised group or call, a triple-quoted string or backtick command.
 * Everything else — a bare name, a short string, a comparison — is always
 * one line, so walking into it looks only for nested candidates.
 */
function visitExpression(expression: Expression | undefined, out: FoldingRange[]): void {
    if (expression === undefined) {
        return;
    }
    switch (expression.kind) {
        case "list":
            add(out, expression.span);
            for (const element of expression.elements) {
                visitExpression(element, out);
            }
            return;
        case "group":
            add(out, expression.span);
            visitExpression(expression.inner, out);
            return;
        case "call":
            add(out, expression.span);
            for (const argument of expression.args) {
                visitExpression(argument, out);
            }
            return;
        case "string":
            // A single- or double-quoted string cannot contain a raw newline
            // and never needs folding; a triple-quoted one can, and its span
            // already covers the whole thing. An unterminated literal is
            // left out: its span runs to wherever the lexer gave up, and
            // offering to fold that is more confusing than useful.
            if (!expression.unterminated) {
                add(out, expression.span);
            }
            return;
        case "backtick":
            if (!expression.unterminated) {
                add(out, expression.span);
            }
            return;
        case "join":
            visitExpression(expression.left, out);
            visitExpression(expression.right, out);
            return;
        case "concat":
            visitExpression(expression.left, out);
            visitExpression(expression.right, out);
            return;
        case "conditional":
            visitExpression(expression.left, out);
            visitExpression(expression.right, out);
            visitExpression(expression.consequent, out);
            visitExpression(expression.alternative, out);
            return;
        default:
            return;
    }
}

function visitDependencies(dependencies: readonly Dependency[], out: FoldingRange[]): void {
    for (const dependency of dependencies) {
        for (const argument of dependency.args) {
            visitExpression(argument, out);
        }
    }
}

function visitParameters(parameters: readonly Parameter[], out: FoldingRange[]): void {
    for (const parameter of parameters) {
        visitExpression(parameter.default, out);
    }
}

function visitRecipe(recipe: Recipe, out: FoldingRange[]): void {
    // The header line stays visible when folded; the body is what collapses.
    // A recipe with no body has nothing to fold.
    if (recipe.body.length > 0) {
        add(out, recipe.span);
    }
    visitParameters(recipe.parameters, out);
    visitDependencies(recipe.dependencies, out);
    visitDependencies(recipe.subsequents, out);
    for (const line of recipe.body) {
        for (const fragment of line.fragments) {
            if (fragment.kind === "interpolation") {
                visitExpression(fragment.expression, out);
            }
        }
    }
}

function visitItem(item: Item, out: FoldingRange[]): void {
    switch (item.kind) {
        case "recipe":
            visitRecipe(item, out);
            return;
        case "assignment":
        case "setting":
            visitExpression(item.value, out);
            return;
        case "import":
        case "module":
            // A path is written as a string, so it goes through the same
            // "only a triple-quoted one can span more than one line" check
            // as any other string — see `visitExpression`'s "string" case.
            visitExpression(item.path, out);
            return;
        default:
            // An alias has only two names, neither able to span a line; an
            // error item has nothing.
            return;
    }
}

/**
 * Is this token the first real thing on its line — not, say, a comment
 * trailing some code on the same line?
 *
 * A `Newline` always precedes the first token of the next line. So, at a
 * line boundary the lexer inserted without one, do `Indent` and `Dedent`:
 * both are synthetic, zero-width markers the lexer emits before looking at
 * the new line's own first character (confirmed against the token stream a
 * recipe body's `Dedent` produces), never something that shares a line with
 * whatever token follows them.
 */
function startsOwnLine(tokens: readonly Token[], index: number): boolean {
    const previous = tokens[index - 1];
    return (
        previous === undefined ||
        previous.kind === TokenKind.Newline ||
        previous.kind === TokenKind.Indent ||
        previous.kind === TokenKind.Dedent
    );
}

/**
 * Comment-block folds, found from the token stream rather than the syntax
 * tree. The parser keeps a comment's text only long enough to become the
 * next item's doc string, then discards its own span — this is the only
 * layer that still has it.
 *
 * Scanning tokens already parsed once, rather than the raw text for lines
 * that start with `#`, is what keeps this correct inside a multi-line
 * string: the lexer already knows a line beginning `#` there is string
 * content, not a comment, and a text scan would not.
 *
 * A trailing comment — one sharing a line with code, `x := "a" # note` — is
 * never the start of a run: `startsOwnLine` excludes it, so a comment run
 * cannot appear to begin on a line that is actually code. It also cannot
 * *extend* one without that check: a run only continues through a bare
 * `Newline` directly followed by a `Comment`, which by construction always
 * starts a fresh line.
 *
 * A run breaks on a blank line between two comments, matching the parser's
 * own rule for when a comment still documents the item below it (see
 * `skipTrivia`'s `pendingDoc` reset) — the two are meant to agree on what
 * counts as one block.
 */
function commentRanges(tokens: readonly Token[]): FoldingRange[] {
    const ranges: FoldingRange[] = [];
    let index = 0;
    while (index < tokens.length) {
        const first = tokens[index];
        if (
            first === undefined ||
            first.kind !== TokenKind.Comment ||
            !startsOwnLine(tokens, index)
        ) {
            index++;
            continue;
        }
        let last = first;
        let cursor = index + 1;
        for (;;) {
            const newline = tokens[cursor];
            const next = tokens[cursor + 1];
            if (
                newline === undefined ||
                newline.kind !== TokenKind.Newline ||
                next === undefined ||
                next.kind !== TokenKind.Comment
            ) {
                break;
            }
            last = next;
            cursor += 2;
        }
        if (last !== first) {
            ranges.push({
                range: {
                    offset: first.span.offset,
                    length: last.span.offset + last.span.length - first.span.offset,
                },
                kind: FoldingKind.Comment,
            });
        }
        index = cursor;
    }
    return ranges;
}

/**
 * Every folding candidate in the file.
 *
 * `tokens` is the same stream `ast` was built from — `ParseCache` keeps both
 * for exactly this — so nothing here re-lexes the document.
 */
export function foldingRanges(ast: Justfile, tokens: readonly Token[]): FoldingRange[] {
    const out: FoldingRange[] = [];
    for (const item of ast.items) {
        visitItem(item, out);
    }
    return [...out, ...commentRanges(tokens)];
}

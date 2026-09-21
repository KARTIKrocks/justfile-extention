/**
 * Semantic tokens, computed from the syntax tree.
 *
 * Tier 1: no VS Code API, no I/O, no subprocesses. See AGENTS.md. The provider
 * layer turns what this returns into `vscode.SemanticTokens`; keeping the
 * decisions here means they are testable in plain Node.
 *
 * This is the layer that knows things the TextMate grammar cannot. A grammar
 * rule sees one line and matches shapes, so `build` in a dependency list and
 * `build` in a recipe header look identical to it. Here the whole file has been
 * parsed, so a definition can be told from a reference and a parameter from a
 * variable.
 *
 * None of this is a correctness judgement. An unknown name still gets the
 * colour its position implies — saying a name is wrong is Tier 2's job.
 */

import type {
    Attribute,
    Dependency,
    Expression,
    Item,
    Justfile,
    Name,
    Parameter,
    Recipe,
} from "../parser/ast.js";

/**
 * Token types, restricted to the ones VS Code themes already style.
 *
 * A theme that has never heard of this extension should light a Justfile up
 * correctly, which rules out inventing custom types.
 */
export const TokenType = {
    Namespace: "namespace",
    Function: "function",
    Variable: "variable",
    Parameter: "parameter",
    Property: "property",
    Decorator: "decorator",
} as const;

export type TokenType = (typeof TokenType)[keyof typeof TokenType];

export const TokenModifier = {
    Declaration: "declaration",
    DefaultLibrary: "defaultLibrary",
} as const;

export type TokenModifier = (typeof TokenModifier)[keyof typeof TokenModifier];

/** The legend. Index into these is what the protocol actually transmits. */
export const TOKEN_TYPES: readonly TokenType[] = Object.values(TokenType);
export const TOKEN_MODIFIERS: readonly TokenModifier[] = Object.values(TokenModifier);

export interface SemanticToken {
    /** Zero-based, matching `vscode.Position`. */
    readonly line: number;
    readonly startCharacter: number;
    /** In UTF-16 code units. */
    readonly length: number;
    readonly type: TokenType;
    readonly modifiers: readonly TokenModifier[];
}

/** Index of a token type in the legend. */
export function typeIndex(type: TokenType): number {
    return TOKEN_TYPES.indexOf(type);
}

/** Modifiers as the bit set the protocol expects. */
export function encodeModifiers(modifiers: readonly TokenModifier[]): number {
    let bits = 0;
    for (const modifier of modifiers) {
        const index = TOKEN_MODIFIERS.indexOf(modifier);
        if (index >= 0) {
            bits |= 1 << index;
        }
    }
    return bits;
}

const DECLARATION: readonly TokenModifier[] = [TokenModifier.Declaration];
const BUILT_IN: readonly TokenModifier[] = [TokenModifier.DefaultLibrary];
const NONE: readonly TokenModifier[] = [];

/** Outside a recipe there are no parameters, and this runs on every keystroke. */
const NO_PARAMETERS: ReadonlySet<string> = new Set();

class Collector {
    readonly tokens: SemanticToken[] = [];

    add(name: Name, type: TokenType, modifiers: readonly TokenModifier[] = NONE): void {
        // A token has to sit on one line and cover something. Neither should
        // happen for an identifier, but a malformed file is the normal case
        // here, and an out-of-range token makes VS Code drop the whole batch.
        if (name.span.length <= 0 || name.text.includes("\n")) {
            return;
        }
        this.tokens.push({
            line: name.span.line,
            startCharacter: name.span.column,
            length: name.span.length,
            type,
            modifiers,
        });
    }
}

function visitExpression(
    expression: Expression | undefined,
    parameters: ReadonlySet<string>,
    out: Collector,
): void {
    if (expression === undefined) {
        return;
    }
    switch (expression.kind) {
        case "variable":
            // Inside a recipe, a name that matches one of its parameters is that
            // parameter. That is just's own scoping, not a guess.
            out.add(
                expression.name,
                parameters.has(expression.name.text) ? TokenType.Parameter : TokenType.Variable,
            );
            return;
        case "call":
            // just has no user-defined functions, so every callee is a built-in.
            out.add(expression.callee, TokenType.Function, BUILT_IN);
            for (const argument of expression.args) {
                visitExpression(argument, parameters, out);
            }
            return;
        case "join":
            visitExpression(expression.left, parameters, out);
            visitExpression(expression.right, parameters, out);
            return;
        case "concat":
            visitExpression(expression.left, parameters, out);
            visitExpression(expression.right, parameters, out);
            return;
        case "conditional":
            visitExpression(expression.left, parameters, out);
            visitExpression(expression.right, parameters, out);
            visitExpression(expression.consequent, parameters, out);
            visitExpression(expression.alternative, parameters, out);
            return;
        case "group":
            visitExpression(expression.inner, parameters, out);
            return;
        case "list":
            for (const element of expression.elements) {
                visitExpression(element, parameters, out);
            }
            return;
        default:
            // Strings, backticks and error nodes carry no names to colour. The
            // grammar already handles their delimiters.
            return;
    }
}

function visitAttributes(attributes: readonly Attribute[], out: Collector): void {
    for (const attribute of attributes) {
        out.add(attribute.name, TokenType.Decorator);
    }
}

function visitDependency(
    dependency: Dependency,
    parameters: ReadonlySet<string>,
    out: Collector,
): void {
    out.add(dependency.name, TokenType.Function);
    for (const argument of dependency.args) {
        visitExpression(argument, parameters, out);
    }
}

function visitParameter(
    parameter: Parameter,
    parameters: ReadonlySet<string>,
    out: Collector,
): void {
    out.add(parameter.name, TokenType.Parameter, DECLARATION);
    // A default may refer to a parameter declared before it, so the whole set is
    // in scope rather than the ones seen so far.
    visitExpression(parameter.default, parameters, out);
}

function visitRecipe(recipe: Recipe, out: Collector): void {
    visitAttributes(recipe.attributes, out);
    out.add(recipe.name, TokenType.Function, DECLARATION);

    const parameters = new Set(recipe.parameters.map((p) => p.name.text));
    for (const parameter of recipe.parameters) {
        visitParameter(parameter, parameters, out);
    }
    for (const dependency of [...recipe.dependencies, ...recipe.subsequents]) {
        visitDependency(dependency, parameters, out);
    }
    for (const line of recipe.body) {
        for (const fragment of line.fragments) {
            if (fragment.kind === "interpolation") {
                visitExpression(fragment.expression, parameters, out);
            }
        }
    }
}

function visitItem(item: Item, out: Collector): void {
    switch (item.kind) {
        case "recipe":
            visitRecipe(item, out);
            return;
        case "assignment":
            out.add(item.name, TokenType.Variable, DECLARATION);
            visitExpression(item.value, NO_PARAMETERS, out);
            return;
        case "setting":
            out.add(item.name, TokenType.Property);
            visitExpression(item.value, NO_PARAMETERS, out);
            return;
        case "alias":
            out.add(item.name, TokenType.Function, DECLARATION);
            if (item.target !== undefined) {
                out.add(item.target, TokenType.Function);
            }
            return;
        case "module":
            visitAttributes(item.attributes, out);
            out.add(item.name, TokenType.Namespace, DECLARATION);
            return;
        default:
            // Imports carry only a path, which the grammar colours as a string.
            // Error items have nothing to say.
            return;
    }
}

/**
 * Put a token list into the shape the protocol demands: sorted by position,
 * with no two tokens overlapping.
 *
 * VS Code rejects the whole batch rather than the offending token, so this is
 * the difference between some highlighting and none. It is exported and tested
 * on its own because the tree walk happens to visit items in source order
 * today; a test that only goes through `semanticTokens` would pass with this
 * function deleted, and would keep passing right up until the walk changed.
 */
export function normalise(tokens: readonly SemanticToken[]): SemanticToken[] {
    const sorted = [...tokens].sort(
        (a, b) => a.line - b.line || a.startCharacter - b.startCharacter,
    );

    const result: SemanticToken[] = [];
    for (const token of sorted) {
        const previous = result[result.length - 1];
        const overlaps =
            previous !== undefined &&
            previous.line === token.line &&
            token.startCharacter < previous.startCharacter + previous.length;
        if (!overlaps) {
            result.push(token);
        }
    }
    return result;
}

/** Every semantic token in the file, in the order the protocol requires. */
export function semanticTokens(ast: Justfile): SemanticToken[] {
    const out = new Collector();
    for (const item of ast.items) {
        visitItem(item, out);
    }
    return normalise(out.tokens);
}

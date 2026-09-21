/**
 * Syntax tree for a Justfile.
 *
 * Tier 1: no VS Code API, no I/O, no subprocesses. See AGENTS.md.
 *
 * This is a *syntax* tree, deliberately distinct from the semantic model in
 * `src/model`. It records what was written, including constructs that are
 * syntactically well-formed but semantically wrong — an unknown attribute, a
 * dependency on a recipe that does not exist. Deciding those are errors is
 * Tier 2's job.
 *
 * Every node carries a span, and every node type has an error-tolerant shape:
 * fields that a half-typed construct would not yet have are optional, so a
 * partial parse still yields a node with a usable range.
 */

import type { Span, StringStyle } from "./token.js";

export interface Node {
    readonly span: Span;
}

/** An identifier, kept as a node so navigation has something to point at. */
export interface Name extends Node {
    readonly kind: "name";
    readonly text: string;
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export type Expression =
    | StringExpression
    | BacktickExpression
    | VariableExpression
    | CallExpression
    | JoinExpression
    | ConcatExpression
    | ConditionalExpression
    | GroupExpression
    | ListExpression
    | ErrorExpression;

export interface StringExpression extends Node {
    readonly kind: "string";
    readonly style: StringStyle;
    /** Absent when the literal was never closed. */
    readonly value?: string;
    readonly unterminated: boolean;
}

/**
 * A backtick command. just evaluates these at *parse* time, which is why
 * running the CLI over an untrusted Justfile is arbitrary code execution.
 */
export interface BacktickExpression extends Node {
    readonly kind: "backtick";
    readonly command: string;
    readonly unterminated: boolean;
}

export interface VariableExpression extends Node {
    readonly kind: "variable";
    readonly name: Name;
}

export interface CallExpression extends Node {
    readonly kind: "call";
    readonly callee: Name;
    readonly args: readonly Expression[];
}

/** `a / b` — path join. */
export interface JoinExpression extends Node {
    readonly kind: "join";
    readonly left?: Expression;
    readonly right?: Expression;
}

/** `a + b` — string concatenation. */
export interface ConcatExpression extends Node {
    readonly kind: "concat";
    readonly left: Expression;
    readonly right?: Expression;
}

export interface ConditionalExpression extends Node {
    readonly kind: "conditional";
    readonly left?: Expression;
    readonly operator?: "==" | "!=" | "=~";
    readonly right?: Expression;
    /**
     * The `{ ... }` branch taken when the comparison holds.
     *
     * Named `consequent` rather than `then` deliberately: an object with a
     * `then` property is thenable, so `await node` or `Promise.resolve(node)`
     * would treat an AST node as a promise and hang or resolve to the wrong
     * thing. Nothing awaits AST nodes today, but the trap costs nothing to
     * remove and everything to debug.
     */
    readonly consequent?: Expression;
    readonly alternative?: Expression;
}

export interface GroupExpression extends Node {
    readonly kind: "group";
    readonly inner?: Expression;
}

/**
 * `["bash", "-cu"]`.
 *
 * `just` parses a bracket group as an expression everywhere an expression is
 * allowed, then rejects most of them during evaluation: outside the three
 * string-list settings, a list needs `set lists`, which is unstable as of
 * 1.58.0. That rejection is semantic, so it is Tier 2's to make and not ours —
 * `just` reports unclosed brackets and missing commas before it ever looks at
 * the setting, which is what tells us the gate is not part of the grammar.
 *
 * `elements` may be empty. `just` rejects `[]` today, but saying so would be a
 * squiggle on a construct a future release could accept; see AGENTS.md on the
 * asymmetric cost of a wrong diagnostic.
 */
export interface ListExpression extends Node {
    readonly kind: "list";
    readonly elements: readonly Expression[];
}

/** Emitted where an expression was required but could not be parsed. */
export interface ErrorExpression extends Node {
    readonly kind: "error-expression";
}

// ---------------------------------------------------------------------------
// Recipe bodies
// ---------------------------------------------------------------------------

/** A literal run of shell text inside a recipe body. */
export interface TextFragment extends Node {
    readonly kind: "text";
    readonly text: string;
}

/** `{{ expr }}` inside a recipe body. */
export interface InterpolationFragment extends Node {
    readonly kind: "interpolation";
    readonly expression?: Expression;
    readonly unterminated: boolean;
}

export type BodyFragment = TextFragment | InterpolationFragment;

export interface BodyLine extends Node {
    readonly kind: "body-line";
    readonly fragments: readonly BodyFragment[];
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export interface AttributeArgument extends Node {
    readonly kind: "attribute-argument";
    readonly value: string;
}

export interface Attribute extends Node {
    readonly kind: "attribute";
    readonly name: Name;
    readonly args: readonly AttributeArgument[];
}

/** How a parameter accepts arguments. Mirrors `kind` in `just --dump` JSON. */
export type ParameterKind = "singular" | "plus" | "star";

export interface Parameter extends Node {
    readonly kind: "parameter";
    readonly name: Name;
    /** `+name` accepts one or more, `*name` zero or more. */
    readonly parameterKind: ParameterKind;
    /** `$name` — exported into the recipe's environment. */
    readonly exported: boolean;
    readonly default?: Expression;
}

export interface Dependency extends Node {
    readonly kind: "dependency";
    readonly name: Name;
    readonly args: readonly Expression[];
}

export interface Recipe extends Node {
    readonly kind: "recipe";
    readonly name: Name;
    readonly attributes: readonly Attribute[];
    readonly parameters: readonly Parameter[];
    /** Dependencies that run before this recipe. */
    readonly dependencies: readonly Dependency[];
    /** Dependencies after `&&`, which run after this recipe's body. */
    readonly subsequents: readonly Dependency[];
    readonly body: readonly BodyLine[];
    /** `@name:` — suppress echoing of the body. */
    readonly quiet: boolean;
    /** The body begins with `#!`, so it runs as a script. */
    readonly shebang: boolean;
    /** The doc comment immediately above, if any. */
    readonly doc?: string;
}

export interface Assignment extends Node {
    readonly kind: "assignment";
    readonly name: Name;
    readonly exported: boolean;
    readonly value?: Expression;
}

export interface Setting extends Node {
    readonly kind: "setting";
    readonly name: Name;
    /** Absent for the boolean shorthand, `set export`. */
    readonly value?: Expression;
}

export interface Alias extends Node {
    readonly kind: "alias";
    readonly name: Name;
    readonly target?: Name;
}

export interface Import extends Node {
    readonly kind: "import";
    /** `import?` tolerates a missing file. */
    readonly optional: boolean;
    readonly path?: StringExpression;
}

export interface ModuleDeclaration extends Node {
    readonly kind: "module";
    readonly name: Name;
    readonly optional: boolean;
    readonly path?: StringExpression;
    readonly attributes: readonly Attribute[];
    readonly doc?: string;
}

/** A line the parser could not classify. Keeps the tree total. */
export interface ErrorItem extends Node {
    readonly kind: "error-item";
    readonly text: string;
}

export type Item = Recipe | Assignment | Setting | Alias | Import | ModuleDeclaration | ErrorItem;

/**
 * A syntax error the parser recovered from.
 *
 * These are *syntax* errors only. The parser must never record anything
 * semantic here — no "unknown recipe", no "undefined variable". See AGENTS.md.
 */
export interface ParseError {
    readonly message: string;
    readonly span: Span;
}

export interface Justfile extends Node {
    readonly kind: "justfile";
    readonly items: readonly Item[];
    readonly errors: readonly ParseError[];
}

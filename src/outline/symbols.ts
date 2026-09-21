/**
 * The document outline, derived from the semantic model.
 *
 * Tier 1: no VS Code API, no I/O, no subprocesses. See AGENTS.md. The provider
 * layer turns this into `vscode.DocumentSymbol`; keeping the shape decisions
 * here means they are testable in plain Node.
 *
 * The layout follows PRD 8.10: assignments gathered under one heading, and
 * recipes gathered under the groups their `[group('...')]` attributes name.
 *
 * Ranges are byte offsets rather than line/column pairs. A span records where
 * a construct starts and how long it is, and turning an end offset back into a
 * position needs the document — which the provider has and this does not.
 */

import type { JustfileModel, ModelParameter, ModelRecipe } from "../model/justfile.js";
import type { Span } from "../parser/token.js";

/**
 * Symbol kinds, named for the `vscode.SymbolKind` members they map to.
 *
 * A frozen object plus a derived union rather than an enum: `erasableSyntaxOnly`
 * forbids enums, and this keeps the values readable in a test failure.
 */
export const OutlineKind = {
    Namespace: "namespace",
    File: "file",
    Variable: "variable",
    Function: "function",
    Module: "module",
    Property: "property",
} as const;

export type OutlineKind = (typeof OutlineKind)[keyof typeof OutlineKind];

/** A half-open byte range into the document. */
export interface OffsetRange {
    readonly offset: number;
    readonly length: number;
}

export interface OutlineSymbol {
    readonly name: string;
    /** Shown beside the name in muted text. Empty when there is nothing to add. */
    readonly detail: string;
    readonly kind: OutlineKind;
    /** The whole construct, which is what gets revealed on click. */
    readonly range: OffsetRange;
    /** Just the name, which is what gets selected. */
    readonly selectionRange: OffsetRange;
    readonly children: readonly OutlineSymbol[];
}

/**
 * Headings this layer invents rather than reads out of the file.
 *
 * Passed in because they are user-facing and must go through `vscode.l10n`,
 * which Tier 1 cannot import. Group names come from the Justfile itself and are
 * never translated.
 */
export interface OutlineLabels {
    readonly variables: string;
}

/** An offset range covering exactly what `span` does. Shared with `src/folding`. */
export function rangeOf(span: Span): OffsetRange {
    return { offset: span.offset, length: span.length };
}

/** The smallest range covering every one of these, for a synthetic heading. */
function spanning(ranges: readonly OffsetRange[]): OffsetRange {
    let start = Number.POSITIVE_INFINITY;
    let end = 0;
    for (const range of ranges) {
        start = Math.min(start, range.offset);
        end = Math.max(end, range.offset + range.length);
    }
    if (!Number.isFinite(start)) {
        return { offset: 0, length: 0 };
    }
    return { offset: start, length: end - start };
}

/**
 * One parameter as it reads in a signature.
 *
 * The default's *value* is deliberately not in the model — just resolves those
 * at parse time and we do not — so a default shows as `=…`. Saying a parameter
 * is optional is worth more here than saying what it falls back to.
 */
function renderParameter(parameter: ModelParameter): string {
    const variadic = parameter.kind === "plus" ? "+" : parameter.kind === "star" ? "*" : "";
    const exported = parameter.export ? "$" : "";
    const fallback = parameter.hasDefault ? "=…" : "";
    return `${variadic}${exported}${parameter.name}${fallback}`;
}

function signatureOf(recipe: ModelRecipe): string {
    return recipe.parameters.map(renderParameter).join(" ");
}

/**
 * The groups a recipe belongs to. just allows more than one.
 *
 * A blank name is dropped rather than made into a heading. `[group('')]` is
 * something just accepts, and VS Code silently discards a symbol with an empty
 * name — heading and recipes together — so the recipe would simply vanish from
 * the outline. Treating it as ungrouped keeps it reachable, which is the whole
 * point of an outline.
 */
function groupsOfRecipe(recipe: ModelRecipe): string[] {
    const names: string[] = [];
    for (const attribute of recipe.attributes) {
        if (attribute.name === "group") {
            names.push(...attribute.args.filter((arg) => arg.trim() !== ""));
        }
    }
    return names;
}

function recipeSymbol(recipe: ModelRecipe): OutlineSymbol {
    return {
        name: recipe.name,
        detail: signatureOf(recipe),
        kind: OutlineKind.Function,
        range: rangeOf(recipe.span),
        selectionRange: rangeOf(recipe.nameSpan),
        children: [],
    };
}

/**
 * An item as it will appear, with the headings it belongs under.
 *
 * Empty `headings` means the item sits at the top level. A recipe can be under
 * more than one, because just lets it carry more than one `[group]`.
 */
interface Entry {
    readonly symbol: OutlineSymbol;
    readonly headings: readonly string[];
}

/** Keys, not names: a group could be called whatever the Variables heading is. */
const VARIABLES = "\u0000variables";
const groupKey = (name: string): string => `\u0000group:${name}`;

/**
 * A heading per unbroken run of its members, rather than one per heading name.
 *
 * Grouping is by attribute, so a group's members need not sit next to each
 * other. One heading spanning from the first member to the last would enclose
 * whatever was written in between, and VS Code answers "which symbol is the
 * cursor in" by descending into the first symbol whose range contains the
 * position — so the breadcrumb would name a group the cursor is not in.
 * Clamping the heading instead left the later members outside their own parent,
 * which VS Code does not expect either.
 *
 * Splitting at the break keeps both properties that matter: every child sits
 * inside its parent, and no heading covers an item that is not its own. A group
 * written in two places in the file shows up in two places in the outline,
 * which is what the file says.
 */
function headingRuns(entries: readonly Entry[], key: string): OutlineSymbol[][] {
    const runs: OutlineSymbol[][] = [];
    let current: OutlineSymbol[] = [];
    for (const entry of entries) {
        if (entry.headings.includes(key)) {
            current.push(entry.symbol);
            continue;
        }
        if (current.length > 0) {
            runs.push(current);
            current = [];
        }
    }
    if (current.length > 0) {
        runs.push(current);
    }
    return runs;
}

/**
 * The outline for a Justfile.
 *
 * Private recipes are included. `just --list` hides them, but this is a
 * navigation tool for the file in front of you, and a recipe you cannot reach
 * from the outline is a recipe you cannot find.
 */
export function outline(model: JustfileModel, labels: OutlineLabels): OutlineSymbol[] {
    const entries: Entry[] = [];

    for (const assignment of model.assignments) {
        entries.push({
            symbol: {
                name: assignment.name,
                detail: assignment.export ? "export" : "",
                kind: OutlineKind.Variable,
                range: rangeOf(assignment.span),
                selectionRange: rangeOf(assignment.nameSpan),
                children: [],
            },
            headings: [VARIABLES],
        });
    }

    for (const recipe of model.recipes) {
        entries.push({
            symbol: recipeSymbol(recipe),
            headings: groupsOfRecipe(recipe).map(groupKey),
        });
    }

    for (const module of model.modules) {
        entries.push({
            symbol: {
                name: module.name,
                detail: module.path ?? "",
                kind: OutlineKind.Module,
                range: rangeOf(module.span),
                selectionRange: rangeOf(module.nameSpan),
                children: [],
            },
            headings: [],
        });
    }

    for (const importation of model.imports) {
        // An import has no name of its own, so its path is the only thing to
        // show. One with no path at all is unnameable and would be dropped by
        // VS Code anyway.
        if (importation.path === "") {
            continue;
        }
        entries.push({
            symbol: {
                name: importation.path,
                detail: importation.optional ? "optional" : "",
                kind: OutlineKind.File,
                range: rangeOf(importation.span),
                selectionRange: rangeOf(importation.span),
                children: [],
            },
            headings: [],
        });
    }

    for (const alias of model.aliases) {
        entries.push({
            symbol: {
                name: alias.name,
                detail: `\u2192 ${alias.target}`,
                kind: OutlineKind.Function,
                range: rangeOf(alias.span),
                selectionRange: rangeOf(alias.nameSpan),
                children: [],
            },
            headings: [],
        });
    }

    for (const setting of model.settings) {
        entries.push({
            symbol: {
                name: setting.name,
                detail: "",
                kind: OutlineKind.Property,
                // A setting has no separate name span in the model; the whole
                // line is close enough to select, and it is one line.
                range: rangeOf(setting.span),
                selectionRange: rangeOf(setting.span),
                children: [],
            },
            headings: [],
        });
    }

    // Runs are read off the source order, so sort before splitting them.
    entries.sort((a, b) => a.symbol.range.offset - b.symbol.range.offset);

    const symbols: OutlineSymbol[] = [];
    for (const entry of entries) {
        if (entry.headings.length === 0) {
            symbols.push(entry.symbol);
        }
    }

    const keys: string[] = [];
    for (const entry of entries) {
        for (const key of entry.headings) {
            if (!keys.includes(key)) {
                keys.push(key);
            }
        }
    }
    for (const key of keys) {
        const name = key === VARIABLES ? labels.variables : key.slice(groupKey("").length);
        for (const children of headingRuns(entries, key)) {
            const range = spanning(children.map((c) => c.range));
            symbols.push({
                name,
                detail: "",
                kind: OutlineKind.Namespace,
                range,
                selectionRange: range,
                children,
            });
        }
    }

    // Source order, so the outline reads like the file. VS Code can re-sort by
    // name if the user prefers; it cannot recover position if we lose it.
    symbols.sort((a, b) => a.range.offset - b.range.offset);
    return symbols;
}

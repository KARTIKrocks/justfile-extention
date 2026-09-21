/**
 * Semantic model of a Justfile.
 *
 * Tier 1: no VS Code API, no I/O, no subprocesses. See AGENTS.md.
 *
 * Field names and shapes deliberately mirror `just --dump --dump-format json`,
 * so the differential harness can compare the two without a translation layer
 * that could itself be wrong.
 *
 * What is *not* here matters as much as what is. The model records structure —
 * names, parameters, dependencies, flags — and never evaluated values. just
 * resolves `version := `git describe`` by running the command at parse time; we
 * cannot and must not. Anything requiring evaluation is Tier 2's answer to give.
 */

import type { Span } from "../parser/token.js";

/** Mirrors `kind` in the dump's parameter objects. */
export type ParameterKind = "singular" | "plus" | "star";

export interface ModelParameter {
    readonly name: string;
    readonly kind: ParameterKind;
    /** `$name` — exported into the recipe's environment. */
    readonly export: boolean;
    /** Whether a default was written. The *value* is not modelled; see above. */
    readonly hasDefault: boolean;
    readonly span: Span;
}

export interface ModelDependency {
    readonly recipe: string;
    /** Argument count only. The arguments themselves may need evaluation. */
    readonly argumentCount: number;
    readonly span: Span;
}

export interface ModelAttribute {
    readonly name: string;
    readonly args: readonly string[];
    readonly span: Span;
}

export interface ModelRecipe {
    readonly name: string;
    readonly parameters: readonly ModelParameter[];
    /** Dependencies that run before the body. */
    readonly dependencies: readonly ModelDependency[];
    /** Dependencies after `&&`, which run after the body. */
    readonly subsequents: readonly ModelDependency[];
    /**
     * Attributes in source order.
     *
     * Note that `just --dump` emits these sorted alphabetically, so any
     * comparison against the dump must sort first.
     */
    readonly attributes: readonly ModelAttribute[];
    readonly doc?: string;
    readonly quiet: boolean;
    readonly shebang: boolean;
    /** Leading underscore or a `[private]` attribute. */
    readonly private: boolean;
    readonly span: Span;
    readonly nameSpan: Span;
}

export interface ModelAssignment {
    readonly name: string;
    readonly export: boolean;
    readonly private: boolean;
    readonly span: Span;
    readonly nameSpan: Span;
}

export interface ModelAlias {
    readonly name: string;
    readonly target: string;
    readonly span: Span;
    readonly nameSpan: Span;
}

export interface ModelSetting {
    readonly name: string;
    /**
     * The value, when it is written as a list of string literals — the form
     * the string-list settings take: `shell`, `windows-shell` and
     * `script-interpreter`.
     *
     * Recorded for any setting written that way, because deciding which
     * settings may hold a list is `just`'s call and not ours. Literal only, and
     * absent otherwise: `set shell := [sh, "-c"]` is valid just, but resolving
     * `sh` means evaluating, which Tier 1 must not do — the same rule that
     * keeps assignment values out of the model entirely. What is here is what
     * the file says, never what it means.
     */
    readonly list?: readonly string[];
    readonly span: Span;
}

export interface ModelImport {
    readonly path: string;
    readonly optional: boolean;
    readonly span: Span;
}

export interface ModelModule {
    readonly name: string;
    readonly optional: boolean;
    readonly path?: string;
    readonly span: Span;
    readonly nameSpan: Span;
}

/**
 * Where this model came from.
 *
 * `cli` models are authoritative: just produced them. `parser` models are a
 * best-effort local approximation, good enough for navigation and completion
 * but never good enough to base a diagnostic on.
 */
export type ModelSource = "parser" | "cli";

export interface JustfileModel {
    readonly source: ModelSource;
    readonly recipes: readonly ModelRecipe[];
    readonly assignments: readonly ModelAssignment[];
    readonly aliases: readonly ModelAlias[];
    readonly settings: readonly ModelSetting[];
    readonly imports: readonly ModelImport[];
    readonly modules: readonly ModelModule[];
    /** The recipe `just` runs with no arguments: the first one defined. */
    readonly first?: string;
}

export function findRecipe(model: JustfileModel, name: string): ModelRecipe | undefined {
    return model.recipes.find((r) => r.name === name);
}

/** Every group named by a `[group('...')]` attribute, deduplicated and sorted. */
export function groupsOf(model: JustfileModel): string[] {
    const groups = new Set<string>();
    for (const recipe of model.recipes) {
        for (const attribute of recipe.attributes) {
            if (attribute.name === "group") {
                for (const arg of attribute.args) {
                    groups.add(arg);
                }
            }
        }
    }
    return [...groups].sort();
}

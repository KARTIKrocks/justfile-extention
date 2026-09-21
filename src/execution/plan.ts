/**
 * Planning a recipe run: which arguments to ask for, and the argv to pass.
 *
 * Tier 1: no VS Code API, no I/O, no subprocesses. See AGENTS.md. Nothing here
 * runs anything — it decides what *would* run, so the rules can be tested in
 * plain Node and the provider layer only has to ask questions and hand the
 * answer to the trust-checked executor in `src/cli/trust.ts`.
 *
 * The rules mirror `just`'s own. `test/differential/execution.test.ts` runs
 * the argv built here against every `just` in the CI matrix, so the two flags
 * and the parsing rule below are proven at the supported floor, not assumed:
 *
 * * After the recipe name `just` stops parsing options, so `-x`, `--verbose`
 *   and even `--` reach the recipe verbatim. No separator is inserted.
 * * Parameters with defaults must follow those without, and only *trailing*
 *   defaults can be omitted — so once an optional parameter is left empty,
 *   nothing after it can be given either.
 * * A recipe has at most one variadic parameter and it comes last. `+` needs
 *   one value or more; `*` accepts none.
 */

import type { ModelParameter, ModelRecipe } from "../model/justfile.js";

/** A single question for the user, in the order they must be asked. */
export interface Prompt {
    readonly parameter: ModelParameter;
    /** Whether an empty answer is a valid "leave it out". */
    readonly optional: boolean;
    /** `plus` and `star`: keep asking until an empty answer. */
    readonly repeatable: boolean;
}

/** A parameter that must be given for the recipe to run at all. */
export function isRequired(parameter: ModelParameter): boolean {
    return parameter.kind === "plus" || (parameter.kind === "singular" && !parameter.hasDefault);
}

/**
 * Whether running `recipe` has to ask for something before it can start.
 *
 * `just build` with no arguments is what "Run" means, and it is only
 * impossible when a parameter has no default.
 */
export function needsArguments(recipe: ModelRecipe): boolean {
    return recipe.parameters.some(isRequired);
}

/** The questions to ask, in parameter order. */
export function promptsFor(recipe: ModelRecipe): Prompt[] {
    return recipe.parameters.map((parameter) => ({
        parameter,
        optional: !isRequired(parameter),
        repeatable: parameter.kind !== "singular",
    }));
}

/**
 * The argument vector for `just`, minus the executable.
 *
 * `--justfile` and `--working-directory` are always explicit (PRD §Running
 * a Recipe), so the run does not depend on which directory the terminal
 * happens to be in. Nothing is joined into a shell string here or anywhere
 * else: the executor hands this array to VS Code, which quotes each element
 * for whatever shell the terminal runs.
 */
export function justArgv(
    justfile: string,
    workingDirectory: string,
    recipe: string,
    args: readonly string[],
): string[] {
    return ["--justfile", justfile, "--working-directory", workingDirectory, recipe, ...args];
}

/** `just build`, for a terminal name or a confirmation. */
export function commandLabel(recipe: string, args: readonly string[]): string {
    return ["just", recipe, ...args].join(" ");
}

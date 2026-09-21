/**
 * Running a recipe: the `Just: Run Recipe` commands behind the CodeLens and
 * the Command Palette.
 *
 * Tier 2 — this is the first feature that executes a Justfile on purpose.
 * PRD §Running a Recipe orders the steps, and the order is the point: trust is
 * checked *first*, before a document is read or a question asked, so the
 * extension never does work on behalf of an untrusted workspace and then
 * refuses at the last moment. The recipe and its parameters come from the
 * Tier 1 model; `just` itself is the authority on whether the call is valid,
 * and its error lands in the terminal where the user can read it.
 *
 * What runs is decided in `src/execution/plan.ts`; what launches it is
 * `startJustTask` in `src/cli/trust.ts`. This module only asks the questions.
 */

import { dirname } from "node:path";
import * as vscode from "vscode";
import { resolveExecutablePath } from "../cli/detect.js";
import { startJustTask } from "../cli/trust.js";
import {
    commandLabel,
    justArgv,
    needsArguments,
    type Prompt,
    promptsFor,
} from "../execution/plan.js";
import type { ParseCache } from "../model/cache.js";
import type { ModelRecipe } from "../model/justfile.js";

export const RUN_COMMAND = "just.runRecipe";
export const RUN_WITH_ARGUMENTS_COMMAND = "just.runRecipeWithArguments";

/** What the CodeLens passes; the Command Palette passes nothing. */
export interface RunTarget {
    readonly uri: vscode.Uri;
    readonly recipe: string;
}

function isRunTarget(value: unknown): value is RunTarget {
    return (
        typeof value === "object" &&
        value !== null &&
        "uri" in value &&
        "recipe" in value &&
        typeof (value as { recipe: unknown }).recipe === "string"
    );
}

/**
 * Explain that nothing runs until the workspace is trusted, with the one
 * action that changes it. Returned rather than thrown so the caller's flow
 * reads top to bottom.
 */
async function explainUntrusted(): Promise<void> {
    const manage = vscode.l10n.t("Manage Workspace Trust");
    const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t(
            "Recipes can only run in a trusted workspace. just evaluates backticks and shell() when it reads a Justfile, so running one is executing it.",
        ),
        manage,
    );
    if (choice === manage) {
        void vscode.commands.executeCommand("workbench.trust.manage");
    }
}

/** The Justfile to run against: the target's, or the one being edited. */
async function documentFor(
    target: RunTarget | undefined,
): Promise<vscode.TextDocument | undefined> {
    if (target !== undefined) {
        return vscode.workspace.openTextDocument(target.uri);
    }
    const active = vscode.window.activeTextEditor?.document;
    if (active?.languageId === "just") {
        return active;
    }
    void vscode.window.showWarningMessage(vscode.l10n.t("Open a Justfile to run a recipe."));
    return undefined;
}

interface RecipeItem extends vscode.QuickPickItem {
    readonly recipe: ModelRecipe;
}

/** The recipe named by the target, or one the user picks. */
async function recipeFor(
    recipes: readonly ModelRecipe[],
    target: RunTarget | undefined,
): Promise<ModelRecipe | undefined> {
    if (target !== undefined) {
        const found = recipes.find((recipe) => recipe.name === target.recipe);
        if (found === undefined) {
            void vscode.window.showWarningMessage(
                vscode.l10n.t("No recipe named {0} in this Justfile.", target.recipe),
            );
        }
        return found;
    }
    if (recipes.length === 0) {
        void vscode.window.showInformationMessage(
            vscode.l10n.t("This Justfile has no recipes to run."),
        );
        return undefined;
    }
    const items: RecipeItem[] = recipes.map((recipe) => {
        const item: RecipeItem = { label: recipe.name, description: recipe.doc ?? "", recipe };
        return recipe.private ? { ...item, detail: vscode.l10n.t("private") } : item;
    });
    const picked = await vscode.window.showQuickPick(items, {
        title: vscode.l10n.t("Run Recipe"),
        placeHolder: vscode.l10n.t("Search recipes…"),
        matchOnDescription: true,
    });
    return picked?.recipe;
}

/** One question. `required` rejects an empty answer; otherwise empty is allowed. */
function ask(
    title: string,
    prompt: string,
    placeHolder: string,
    required: string | undefined,
): Thenable<string | undefined> {
    const options: vscode.InputBoxOptions = { title, prompt, placeHolder };
    return vscode.window.showInputBox(
        required === undefined
            ? options
            : { ...options, validateInput: (text) => (text === "" ? required : undefined) },
    );
}

/** Nothing given for this parameter: the run stops asking, or is cancelled. */
type Answer =
    | { readonly cancelled: true }
    | { readonly cancelled: false; readonly values: string[] };

const CANCELLED: Answer = { cancelled: true };

async function askSingular(title: string, { parameter, optional }: Prompt): Promise<Answer> {
    const value = await ask(
        title,
        optional
            ? vscode.l10n.t("{0} (leave empty to use its default)", parameter.name)
            : parameter.name,
        parameter.name,
        optional ? undefined : vscode.l10n.t("{0} is required.", parameter.name),
    );
    if (value === undefined) {
        return CANCELLED;
    }
    return { cancelled: false, values: value === "" ? [] : [value] };
}

/**
 * `+name` needs at least one value; `*name` accepts none. Each value is its
 * own answer and its own argument — a single box split on spaces would break
 * a value containing one (PRD 8.14). After the first, an empty answer means
 * "that is all of them".
 */
async function askVariadic(title: string, { parameter, optional }: Prompt): Promise<Answer> {
    const values: string[] = [];
    for (let index = 1; ; index++) {
        const first = index === 1;
        const prompt = first
            ? optional
                ? vscode.l10n.t("{0} (variadic; leave empty for none)", parameter.name)
                : vscode.l10n.t("{0} (variadic; at least one value)", parameter.name)
            : vscode.l10n.t("{0}, value {1} (leave empty to finish)", parameter.name, index);
        const value = await ask(
            title,
            prompt,
            parameter.name,
            first && !optional
                ? vscode.l10n.t("{0} needs at least one value.", parameter.name)
                : undefined,
        );
        if (value === undefined) {
            return CANCELLED;
        }
        if (value === "") {
            return { cancelled: false, values };
        }
        values.push(value);
    }
}

/**
 * Ask for each parameter in order. `undefined` means the user cancelled;
 * the run must then not start.
 *
 * Only *trailing* defaults can be omitted, so the first parameter left
 * empty ends the questions: anything after it cannot be given either.
 */
async function collectArguments(
    recipe: ModelRecipe,
    prompts: readonly Prompt[],
): Promise<string[] | undefined> {
    const title = vscode.l10n.t("Run {0}", recipe.name);
    const args: string[] = [];
    for (const prompt of prompts) {
        const answer = prompt.repeatable
            ? await askVariadic(title, prompt)
            : await askSingular(title, prompt);
        if (answer.cancelled) {
            return undefined;
        }
        if (answer.values.length === 0) {
            break;
        }
        args.push(...answer.values);
    }
    return args;
}

export function registerRunRecipe(context: vscode.ExtensionContext, cache: ParseCache): void {
    async function run(target: RunTarget | undefined, withArguments: boolean): Promise<void> {
        // First, before anything else. See the module comment.
        if (!vscode.workspace.isTrusted) {
            await explainUntrusted();
            return;
        }

        const document = await documentFor(target);
        if (document === undefined) {
            return;
        }
        if (document.uri.scheme !== "file") {
            void vscode.window.showWarningMessage(
                vscode.l10n.t("Save the Justfile to disk before running a recipe."),
            );
            return;
        }

        const { model } = cache.parse(
            document.uri.toString(),
            document.version,
            document.getText(),
        );
        const recipe = await recipeFor(model.recipes, target);
        if (recipe === undefined) {
            return;
        }

        let args: string[] = [];
        if (withArguments || needsArguments(recipe)) {
            const collected = await collectArguments(recipe, promptsFor(recipe));
            if (collected === undefined) {
                return;
            }
            args = collected;
        }

        // just reads the file from disk, not the editor buffer. Running what
        // the user sees rather than what they last saved is the less
        // surprising of the two.
        if (document.isDirty && !(await document.save())) {
            return;
        }

        const justfile = document.uri.fsPath;
        const cwd = dirname(justfile);
        const outcome = await startJustTask(
            resolveExecutablePath(document.uri),
            justArgv(justfile, cwd, recipe.name, args),
            {
                cwd,
                scope:
                    vscode.workspace.getWorkspaceFolder(document.uri) ?? vscode.TaskScope.Workspace,
                label: commandLabel(recipe.name, args),
                recipe: recipe.name,
            },
        );
        if (!outcome.ok) {
            // Trust was revoked between the check above and here. Rare, but
            // the backstop in `startJustTask` exists for exactly this.
            await explainUntrusted();
        }
    }

    context.subscriptions.push(
        vscode.commands.registerCommand(RUN_COMMAND, (target?: unknown) =>
            run(isRunTarget(target) ? target : undefined, false),
        ),
        vscode.commands.registerCommand(RUN_WITH_ARGUMENTS_COMMAND, (target?: unknown) =>
            run(isRunTarget(target) ? target : undefined, true),
        ),
    );
}

/**
 * The `▶ Run` CodeLens above every recipe.
 *
 * Tier 1 to produce, Tier 2 to act on: the lenses come from the in-process
 * model with no I/O, so they appear in an untrusted workspace too — but there
 * they say so and lead to the trust dialog instead of pretending a run is one
 * click away. Clicking one in a trusted workspace goes through
 * `just.runRecipe`, which checks trust again before doing anything.
 *
 * PRD 8.12: the default lenses are Run and Run with Arguments only, and the
 * whole row can be turned off, because a lens above every recipe is noise in
 * a large Justfile. Run with Arguments is only offered when the recipe has
 * parameters — on one that has none it would ask nothing and do the same as
 * Run.
 */

import * as vscode from "vscode";
import { needsArguments } from "../execution/plan.js";
import type { ParseCache } from "../model/cache.js";
import { RUN_COMMAND, RUN_WITH_ARGUMENTS_COMMAND, type RunTarget } from "./runRecipe.js";

const SELECTOR: vscode.DocumentSelector = { language: "just" };
const CONFIG_SECTION = "just";
const CONFIG_KEY = "codeLens.enabled";

export function registerCodeLens(context: vscode.ExtensionContext, cache: ParseCache): void {
    const changed = new vscode.EventEmitter<void>();
    context.subscriptions.push(changed);

    const provider: vscode.CodeLensProvider = {
        onDidChangeCodeLenses: changed.event,

        provideCodeLenses(document) {
            const enabled = vscode.workspace
                .getConfiguration(CONFIG_SECTION, document.uri)
                .get<boolean>(CONFIG_KEY, true);
            if (!enabled) {
                return [];
            }
            const { model } = cache.parse(
                document.uri.toString(),
                document.version,
                document.getText(),
            );
            const trusted = vscode.workspace.isTrusted;
            const lenses: vscode.CodeLens[] = [];
            for (const recipe of model.recipes) {
                const position = document.positionAt(recipe.nameSpan.offset);
                const range = new vscode.Range(position, position);
                const target: RunTarget = { uri: document.uri, recipe: recipe.name };

                if (!trusted) {
                    lenses.push(
                        new vscode.CodeLens(range, {
                            title: vscode.l10n.t("$(shield) Run (requires workspace trust)"),
                            tooltip: vscode.l10n.t(
                                "Recipes can only run in a trusted workspace. Click to manage trust.",
                            ),
                            command: "workbench.trust.manage",
                        }),
                    );
                    continue;
                }

                // A recipe with a required parameter cannot run bare, so its
                // one lens asks — same command, and the title says so.
                const asks = needsArguments(recipe);
                lenses.push(
                    new vscode.CodeLens(range, {
                        title: asks ? vscode.l10n.t("$(play) Run…") : vscode.l10n.t("$(play) Run"),
                        tooltip: vscode.l10n.t("Run just {0} in the terminal", recipe.name),
                        command: RUN_COMMAND,
                        arguments: [target],
                    }),
                );
                if (recipe.parameters.length > 0 && !asks) {
                    lenses.push(
                        new vscode.CodeLens(range, {
                            title: vscode.l10n.t("Run with Arguments…"),
                            tooltip: vscode.l10n.t(
                                "Choose arguments, then run just {0}",
                                recipe.name,
                            ),
                            command: RUN_WITH_ARGUMENTS_COMMAND,
                            arguments: [target],
                        }),
                    );
                }
            }
            return lenses;
        },
    };

    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(SELECTOR, provider),
        // The lenses read trust and the setting at render time; both can
        // change without the document changing, so tell VS Code to ask again.
        vscode.workspace.onDidGrantWorkspaceTrust(() => changed.fire()),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_KEY}`)) {
                changed.fire();
            }
        }),
    );
}

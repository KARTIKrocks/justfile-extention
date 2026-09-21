/**
 * Extension entry point.
 *
 * Activation is a budget, not a preference: under 50 ms, no I/O, no subprocess,
 * no runtime dependencies. See AGENTS.md. Anything expensive is built lazily on
 * first use, and anything that runs `just` waits for Workspace Trust.
 */

import * as vscode from "vscode";
import { ParseCache } from "./model/cache.js";
import { registerCliStatus } from "./providers/cliStatus.js";
import { registerDocumentSymbols } from "./providers/documentSymbols.js";
import { forgetClosedDocuments } from "./providers/documents.js";
import { registerFolding } from "./providers/folding.js";
import { registerSemanticTokens } from "./providers/semanticTokens.js";

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel("Just", { log: true });
    context.subscriptions.push(output);

    output.info(
        vscode.l10n.t(
            "Justfile extension activated (workspace trusted: {0})",
            String(vscode.workspace.isTrusted),
        ),
    );

    // One parse per document per edit, shared by every Tier 1 feature. Empty at
    // activation: nothing is parsed until a provider is actually asked.
    const cache = new ParseCache();
    forgetClosedDocuments(context, cache);

    // Registering a provider does not run it, so this stays within the budget.
    registerSemanticTokens(context, cache);
    registerDocumentSymbols(context, cache);
    registerFolding(context, cache);

    // The first Tier 2 feature. Registration itself is synchronous and
    // cheap, same as the providers above; unlike them, it can eventually
    // spawn `just --version`, but not from here — that first detection
    // waits for real demand (a justfile opening, trust being granted, and
    // so on), never for activation itself. See cliStatus.ts.
    registerCliStatus(context);

    // Trust can be granted mid-session, so it is read at call time rather than
    // captured here. This listener exists to light up Tier 2 when that happens.
    context.subscriptions.push(
        vscode.workspace.onDidGrantWorkspaceTrust(() => {
            output.info(
                vscode.l10n.t("Workspace trusted; features that run just are now available."),
            );
        }),
    );
}

export function deactivate(): void {
    // Nothing to tear down: everything owned by the extension is registered in
    // `context.subscriptions` and disposed by VS Code.
}

/**
 * Document lifecycle wiring.
 *
 * The parse cache holds a tree per open document. Nothing evicts it on its own,
 * so without this a long session accumulates the parse of every Justfile the
 * user ever opened. Kept apart from `activate` so it can be tested against a
 * real cache rather than asserted by reading the code.
 */

import * as vscode from "vscode";
import type { ParseCache } from "../model/cache.js";

export function forgetClosedDocuments(context: vscode.ExtensionContext, cache: ParseCache): void {
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((document) => {
            cache.forget(document.uri.toString());
        }),
    );
}

/**
 * The semantic token provider.
 *
 * The provider layer is the only place that touches the VS Code API, so this
 * file is deliberately thin: it converts, it does not decide. Everything about
 * which name gets which token lives in `src/highlight`, where it can be tested
 * without an editor.
 *
 * Tier 1 throughout — the parser, nothing else — so this works in an untrusted
 * workspace. Nothing here spawns a process or reads a file.
 */

import * as vscode from "vscode";
import {
    encodeModifiers,
    semanticTokens,
    TOKEN_MODIFIERS,
    TOKEN_TYPES,
    typeIndex,
} from "../highlight/semanticTokens.js";
import type { ParseCache } from "../model/cache.js";

export const LEGEND = new vscode.SemanticTokensLegend([...TOKEN_TYPES], [...TOKEN_MODIFIERS]);

/** `{ language: "just" }` — every document the language contribution claims. */
const SELECTOR: vscode.DocumentSelector = { language: "just" };

export function registerSemanticTokens(context: vscode.ExtensionContext, cache: ParseCache): void {
    const provider: vscode.DocumentSemanticTokensProvider = {
        provideDocumentSemanticTokens(document) {
            const { ast } = cache.parse(
                document.uri.toString(),
                document.version,
                document.getText(),
            );
            const builder = new vscode.SemanticTokensBuilder(LEGEND);
            for (const token of semanticTokens(ast)) {
                builder.push(
                    token.line,
                    token.startCharacter,
                    token.length,
                    typeIndex(token.type),
                    encodeModifiers(token.modifiers),
                );
            }
            return builder.build();
        },
    };

    context.subscriptions.push(
        vscode.languages.registerDocumentSemanticTokensProvider(SELECTOR, provider, LEGEND),
    );
}

/**
 * The document symbol provider, behind the Outline panel and breadcrumbs.
 *
 * Thin by design: the shape of the outline is decided in `src/outline`, where
 * it can be tested without an editor. What is left here is turning byte offsets
 * into positions, which needs the document, and mapping our kinds onto VS
 * Code's.
 *
 * Tier 1 throughout, so this works in an untrusted workspace.
 */

import * as vscode from "vscode";
import type { ParseCache } from "../model/cache.js";
import { type OffsetRange, OutlineKind, type OutlineSymbol, outline } from "../outline/symbols.js";

const SELECTOR: vscode.DocumentSelector = { language: "just" };

const KINDS: Readonly<Record<OutlineKind, vscode.SymbolKind>> = {
    [OutlineKind.Namespace]: vscode.SymbolKind.Namespace,
    [OutlineKind.File]: vscode.SymbolKind.File,
    [OutlineKind.Variable]: vscode.SymbolKind.Variable,
    [OutlineKind.Function]: vscode.SymbolKind.Function,
    [OutlineKind.Module]: vscode.SymbolKind.Module,
    [OutlineKind.Property]: vscode.SymbolKind.Property,
};

function toRange(document: vscode.TextDocument, range: OffsetRange): vscode.Range {
    return new vscode.Range(
        document.positionAt(range.offset),
        document.positionAt(range.offset + range.length),
    );
}

function toSymbol(document: vscode.TextDocument, symbol: OutlineSymbol): vscode.DocumentSymbol {
    const converted = new vscode.DocumentSymbol(
        symbol.name,
        symbol.detail,
        KINDS[symbol.kind],
        toRange(document, symbol.range),
        toRange(document, symbol.selectionRange),
    );
    converted.children = symbol.children.map((child) => toSymbol(document, child));
    return converted;
}

export function registerDocumentSymbols(context: vscode.ExtensionContext, cache: ParseCache): void {
    const provider: vscode.DocumentSymbolProvider = {
        provideDocumentSymbols(document) {
            const { model } = cache.parse(
                document.uri.toString(),
                document.version,
                document.getText(),
            );
            // Headings this layer invents have to be translatable; the group
            // names come from the file and never are.
            const labels = { variables: vscode.l10n.t("Variables") };
            return outline(model, labels).map((symbol) => toSymbol(document, symbol));
        },
    };

    context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(SELECTOR, provider));
}

/**
 * The folding range provider, behind the gutter's fold chevrons and "Fold
 * All" / "Fold All Comments".
 *
 * Thin by design: which constructs are foldable is decided in `src/folding`,
 * where it can be tested without an editor. What is left here is turning byte
 * offsets into line numbers, which needs the document, and dropping a
 * candidate that the document shows is not actually more than one line —
 * `(a)` and `(\n    a\n)` parse to the same shape of node, and only a real
 * document can tell them apart.
 *
 * Tier 1 throughout, so this works in an untrusted workspace.
 */

import * as vscode from "vscode";
import { FoldingKind, type FoldingRange, foldingRanges } from "../folding/ranges.js";
import type { ParseCache } from "../model/cache.js";

const SELECTOR: vscode.DocumentSelector = { language: "just" };

const KINDS: Readonly<Record<FoldingKind, vscode.FoldingRangeKind>> = {
    [FoldingKind.Comment]: vscode.FoldingRangeKind.Comment,
};

function toFoldingRange(
    document: vscode.TextDocument,
    range: FoldingRange,
): vscode.FoldingRange | undefined {
    const start = document.positionAt(range.range.offset).line;
    const end = document.positionAt(range.range.offset + range.range.length).line;
    // A candidate that turns out to sit on one line is not a fold at all —
    // VS Code ignores it, but making that explicit here is what the "not yet
    // known to span more than one line" note in `src/folding/ranges.ts`
    // means in practice.
    if (end <= start) {
        return undefined;
    }
    return new vscode.FoldingRange(
        start,
        end,
        range.kind === undefined ? undefined : KINDS[range.kind],
    );
}

export function registerFolding(context: vscode.ExtensionContext, cache: ParseCache): void {
    const provider: vscode.FoldingRangeProvider = {
        provideFoldingRanges(document) {
            const { ast, tokens } = cache.parse(
                document.uri.toString(),
                document.version,
                document.getText(),
            );
            const ranges: vscode.FoldingRange[] = [];
            for (const candidate of foldingRanges(ast, tokens)) {
                const range = toFoldingRange(document, candidate);
                if (range !== undefined) {
                    ranges.push(range);
                }
            }
            return ranges;
        },
    };

    context.subscriptions.push(vscode.languages.registerFoldingRangeProvider(SELECTOR, provider));
}

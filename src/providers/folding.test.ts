/**
 * The folding range provider, against a stand-in for the editor.
 *
 * Which constructs are foldable is `src/folding`'s business and is tested
 * there. What is left here is the conversion: byte offsets into line numbers,
 * dropping a candidate that turns out to be one line, and mapping our kinds
 * onto VS Code's.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
    FoldingRange,
    FoldingRangeKind,
    Position,
    recorded,
    resetStub,
} from "../../test/stubs/vscode.js";
import { ParseCache } from "../model/cache.js";
import { registerFolding } from "./folding.js";

/** A document that converts offsets the way `vscode.TextDocument` does. */
function documentOf(text: string, version = 1, uri = "file:///justfile") {
    return {
        uri: { toString: () => uri },
        version,
        getText: () => text,
        positionAt(offset: number) {
            const clamped = Math.max(0, Math.min(offset, text.length));
            const before = text.slice(0, clamped);
            const line = before.split("\n").length - 1;
            return new Position(line, clamped - (before.lastIndexOf("\n") + 1));
        },
    };
}

function contextOf(): { subscriptions: { dispose(): void }[] } {
    return { subscriptions: [] };
}

function foldsFor(text: string): FoldingRange[] {
    const context = contextOf();
    registerFolding(context as never, new ParseCache());
    const registration = recorded.foldingRangeProviders.at(-1);
    if (registration === undefined) {
        throw new Error("the provider did not register itself");
    }
    return registration.provider.provideFoldingRanges(documentOf(text)) as FoldingRange[];
}

beforeEach(resetStub);

describe("registration", () => {
    it("registers for the just language and hands back a disposable", () => {
        const context = contextOf();
        registerFolding(context as never, new ParseCache());
        expect(recorded.foldingRangeProviders[0]?.selector).toEqual({ language: "just" });
        expect(context.subscriptions).toHaveLength(1);
    });
});

describe("conversion", () => {
    it("turns offsets into the line numbers a fold actually needs", () => {
        const folds = foldsFor("build:\n    echo one\n    echo two\n");
        expect(folds).toContainEqual(new FoldingRange(0, 2, undefined));
    });

    it("drops a candidate that turns out to sit on one line", () => {
        // `["a", "b"]` is a folding candidate at the pure layer regardless of
        // line count — see src/folding/ranges.ts — so this is what proves the
        // provider is the one actually filtering it out here.
        const folds = foldsFor('x := ["a", "b"]\n');
        expect(folds).toEqual([]);
    });

    it("maps the comment kind onto VS Code's", () => {
        const folds = foldsFor("# one\n# two\nbuild:\n    echo hi\n");
        expect(folds).toContainEqual(new FoldingRange(0, 1, FoldingRangeKind.Comment));
    });

    it("leaves an ordinary fold without a kind", () => {
        const folds = foldsFor("build:\n    echo one\n    echo two\n");
        expect(folds[0]?.kind).toBeUndefined();
    });

    it("answers for an empty document", () => {
        expect(foldsFor("")).toEqual([]);
    });

    it("answers for a document the parser had to recover from", () => {
        expect(() => foldsFor('broken := "oops\n\nbuild:\n')).not.toThrow();
    });
});

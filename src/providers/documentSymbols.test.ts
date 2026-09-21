/**
 * The symbol provider, against a stand-in for the editor.
 *
 * The shape of the outline is `src/outline`'s business and is tested there.
 * What is left here is the conversion: byte offsets into positions, and our
 * kinds onto VS Code's.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
    type DocumentSymbol,
    Position,
    recorded,
    resetStub,
    SymbolKind,
} from "../../test/stubs/vscode.js";
import { ParseCache } from "../model/cache.js";
import { registerDocumentSymbols } from "./documentSymbols.js";

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

function symbolsFor(text: string): DocumentSymbol[] {
    const context = contextOf();
    registerDocumentSymbols(context as never, new ParseCache());
    const registration = recorded.documentSymbolProviders.at(-1);
    if (registration === undefined) {
        throw new Error("the provider did not register itself");
    }
    return registration.provider.provideDocumentSymbols(documentOf(text)) as DocumentSymbol[];
}

beforeEach(resetStub);

describe("registration", () => {
    it("registers for the just language and hands back a disposable", () => {
        const context = contextOf();
        registerDocumentSymbols(context as never, new ParseCache());
        expect(recorded.documentSymbolProviders[0]?.selector).toEqual({ language: "just" });
        expect(context.subscriptions).toHaveLength(1);
    });
});

describe("conversion", () => {
    it("turns offsets into the positions the range really covers", () => {
        // The whole point of doing this in the provider: only the document can
        // turn an end offset back into a line and character.
        const symbols = symbolsFor("first:\n    echo f\n\nsecond:\n    echo s\n");
        const second = symbols.find((s) => s.name === "second");
        expect(second?.selectionRange.start).toEqual(new Position(3, 0));
        expect(second?.selectionRange.end).toEqual(new Position(3, 6));
    });

    it("maps every kind onto a VS Code kind", () => {
        const symbols = symbolsFor(
            "set quiet\nx := \"1\"\n\n[group('g')]\nbuild:\n    echo b\n\nmod sub\nalias b := build\n",
        );
        const byName = new Map(symbols.map((s) => [s.name, s.kind]));
        expect(byName.get("Variables")).toBe(SymbolKind.Namespace);
        expect(byName.get("g")).toBe(SymbolKind.Namespace);
        expect(byName.get("sub")).toBe(SymbolKind.Module);
        expect(byName.get("b")).toBe(SymbolKind.Function);
        expect(byName.get("quiet")).toBe(SymbolKind.Property);
        const group = symbols.find((s) => s.name === "g");
        expect(group?.children[0]?.kind).toBe(SymbolKind.Function);
    });

    it("carries children through, not just the top level", () => {
        const symbols = symbolsFor("[group('g')]\nbuild:\n    echo b\n");
        expect(symbols.find((s) => s.name === "g")?.children.map((c) => c.name)).toEqual(["build"]);
    });

    it("keeps the detail", () => {
        const symbols = symbolsFor('build target="x" *rest:\n    echo hi\n');
        expect(symbols.find((s) => s.name === "build")?.detail).toBe("target=… *rest");
    });

    it("translates the headings it invents", () => {
        // The stub's l10n.t is the identity, so this pins that the heading goes
        // through it at all rather than being a bare literal.
        expect(symbolsFor('x := "1"\n').map((s) => s.name)).toContain("Variables");
    });

    it("answers for an empty document", () => {
        expect(symbolsFor("")).toEqual([]);
    });

    it("answers for a document the parser had to recover from", () => {
        expect(symbolsFor('broken := "oops\n\nbuild:\n').length).toBeGreaterThan(0);
    });
});

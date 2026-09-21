/**
 * The provider layer, against a stand-in for the editor.
 *
 * `src/highlight` decides which name gets which token and is tested on its own.
 * What is left here is registration and encoding — the wiring that no unit test
 * would otherwise touch, and where a wrong argument order ships silently.
 */

import { beforeEach, describe, expect, it } from "vitest";
// Resolved to test/stubs/vscode.ts by the alias in vitest.config.mts.
import { recorded, resetStub, type SemanticTokens } from "../../test/stubs/vscode.js";
import {
    encodeModifiers,
    TOKEN_MODIFIERS,
    TOKEN_TYPES,
    TokenModifier,
    TokenType,
    typeIndex,
} from "../highlight/semanticTokens.js";
import { ParseCache } from "../model/cache.js";
import { LEGEND, registerSemanticTokens } from "./semanticTokens.js";

interface FakeDocument {
    uri: { toString(): string };
    version: number;
    getText(): string;
}

function documentOf(text: string, version = 1, uri = "file:///justfile"): FakeDocument {
    return { uri: { toString: () => uri }, version, getText: () => text };
}

function contextOf(): { subscriptions: { dispose(): void }[] } {
    return { subscriptions: [] };
}

/** Register the provider and hand back the pieces a test needs. */
function register(cache = new ParseCache()) {
    const context = contextOf();
    // The stub's shapes stand in for the real ones, which the compiler checks
    // against @types/vscode; the cast is only for the test's own plumbing.
    registerSemanticTokens(context as never, cache);
    const registration = recorded.semanticTokenProviders.at(-1);
    if (registration === undefined) {
        throw new Error("the provider did not register itself");
    }
    return { context, cache, registration };
}

function tokensFor(text: string): SemanticTokens {
    const { registration } = register();
    return registration.provider.provideDocumentSemanticTokens(documentOf(text)) as SemanticTokens;
}

beforeEach(resetStub);

describe("registration", () => {
    it("registers for the just language", () => {
        const { registration } = register();
        expect(registration.selector).toEqual({ language: "just" });
    });

    it("hands VS Code a disposable to clean up", () => {
        const { context } = register();
        expect(context.subscriptions).toHaveLength(1);
        expect(() => context.subscriptions[0]?.dispose()).not.toThrow();
    });

    it("declares the same legend it encodes against", () => {
        // A legend that disagrees with the indices sent over the wire colours
        // every token as the wrong thing, and nothing reports it.
        const { registration } = register();
        expect(registration.legend).toBe(LEGEND);
        expect(registration.legend.tokenTypes).toEqual([...TOKEN_TYPES]);
        expect(registration.legend.tokenModifiers).toEqual([...TOKEN_MODIFIERS]);
    });
});

describe("encoding", () => {
    it("sends a recipe name as a function declaration", () => {
        const built = tokensFor("build:\n    echo hi\n");
        expect(built.pushed).toContainEqual({
            line: 0,
            char: 0,
            length: 5,
            tokenType: typeIndex(TokenType.Function),
            tokenModifiers: encodeModifiers([TokenModifier.Declaration]),
        });
    });

    it("sends position, length, type and modifiers in that order", () => {
        // `push(line, char, length, type, modifiers)` — swapping any pair still
        // compiles and still produces tokens, just in the wrong places.
        const built = tokensFor("greet target:\n    echo {{ target }}\n");
        const use = built.pushed.find((t) => t.line === 1);
        expect(use).toEqual({
            line: 1,
            char: 12,
            length: 6,
            tokenType: typeIndex(TokenType.Parameter),
            tokenModifiers: 0,
        });
    });

    it("emits nothing for an empty document rather than failing", () => {
        expect(tokensFor("").pushed).toEqual([]);
    });

    it("still answers for a document the parser had to recover from", () => {
        const built = tokensFor('broken := "oops\n\nbuild:\n');
        expect(built.pushed.length).toBeGreaterThan(0);
    });
});

describe("caching", () => {
    it("parses once when asked twice for the same version", () => {
        const cache = new ParseCache();
        const { registration } = register(cache);
        const document = documentOf("build:\n    echo hi\n");
        registration.provider.provideDocumentSemanticTokens(document);
        const first = cache.parse(document.uri.toString(), document.version, document.getText());
        registration.provider.provideDocumentSemanticTokens(document);
        const second = cache.parse(document.uri.toString(), document.version, document.getText());
        expect(second.ast).toBe(first.ast);
    });

    it("picks up an edit", () => {
        const cache = new ParseCache();
        const { registration } = register(cache);
        registration.provider.provideDocumentSemanticTokens(documentOf("a:\n    echo a\n", 1));
        const built = registration.provider.provideDocumentSemanticTokens(
            documentOf("alpha:\n    echo a\n", 2),
        ) as SemanticTokens;
        expect(built.pushed[0]?.length).toBe(5);
    });
});

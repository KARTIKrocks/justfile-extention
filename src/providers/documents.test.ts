import { beforeEach, describe, expect, it } from "vitest";
import { recorded, resetStub } from "../../test/stubs/vscode.js";
import { ParseCache } from "../model/cache.js";
import { forgetClosedDocuments } from "./documents.js";

function contextOf(): { subscriptions: { dispose(): void }[] } {
    return { subscriptions: [] };
}

beforeEach(resetStub);

describe("forgetClosedDocuments", () => {
    it("drops a document's parse when its editor closes", () => {
        const cache = new ParseCache();
        forgetClosedDocuments(contextOf() as never, cache);
        cache.parse("file:///justfile", 1, "build:\n    echo hi\n");
        expect(cache.size).toBe(1);

        recorded.onDidCloseTextDocument.emit({ uri: { toString: () => "file:///justfile" } });
        expect(cache.size).toBe(0);
    });

    it("leaves other documents alone", () => {
        const cache = new ParseCache();
        forgetClosedDocuments(contextOf() as never, cache);
        cache.parse("file:///a", 1, "a:\n    echo a\n");
        cache.parse("file:///b", 1, "b:\n    echo b\n");

        recorded.onDidCloseTextDocument.emit({ uri: { toString: () => "file:///a" } });
        expect(cache.size).toBe(1);
    });

    it("registers its listener for disposal", () => {
        const context = contextOf();
        forgetClosedDocuments(context as never, new ParseCache());
        expect(context.subscriptions).toHaveLength(1);
    });
});

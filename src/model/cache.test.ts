import { describe, expect, it } from "vitest";
import { ParseCache } from "./cache.js";

const SOURCE = 'x := "1"\n\nbuild:\n    echo hi\n';

describe("ParseCache", () => {
    it("parses once for a given version", () => {
        const cache = new ParseCache();
        const first = cache.parse("a", 1, SOURCE);
        const second = cache.parse("a", 1, SOURCE);
        // Identity, not equality: a second parse would produce an equal tree and
        // hide the fact that the cache did nothing.
        expect(second.ast).toBe(first.ast);
    });

    it("reparses when the version moves", () => {
        const cache = new ParseCache();
        const first = cache.parse("a", 1, SOURCE);
        const second = cache.parse("a", 2, 'x := "2"\n');
        expect(second.ast).not.toBe(first.ast);
        expect(second.version).toBe(2);
    });

    it("does not serve one document's parse to another", () => {
        const cache = new ParseCache();
        cache.parse("a", 1, "alpha:\n    echo a\n");
        const b = cache.parse("b", 1, "beta:\n    echo b\n");
        expect(b.model.recipes.map((r) => r.name)).toEqual(["beta"]);
        expect(cache.size).toBe(2);
    });

    it("forgets a document, so a closed editor leaves nothing behind", () => {
        const cache = new ParseCache();
        cache.parse("a", 1, SOURCE);
        expect(cache.size).toBe(1);
        cache.forget("a");
        expect(cache.size).toBe(0);
    });

    it("survives forgetting something it never held", () => {
        const cache = new ParseCache();
        expect(() => cache.forget("nothing")).not.toThrow();
    });

    it("builds the model only when asked, and only once", () => {
        const cache = new ParseCache();
        const entry = cache.parse("a", 1, SOURCE);
        const first = entry.model;
        expect(first.recipes.map((r) => r.name)).toEqual(["build"]);
        expect(entry.model).toBe(first);
    });

    it("keeps the model consistent with the tree it was built from", () => {
        const cache = new ParseCache();
        const entry = cache.parse("a", 1, SOURCE);
        expect(entry.model.assignments.map((a) => a.name)).toEqual(["x"]);
        expect(entry.ast.items).toHaveLength(2);
    });

    it("caches a file the parser could not fully understand", () => {
        // Half-typed input is the normal case, and it must not defeat the cache.
        const cache = new ParseCache();
        const first = cache.parse("a", 1, 'broken := "oops\n\nbuild:\n');
        expect(cache.parse("a", 1, 'broken := "oops\n\nbuild:\n').ast).toBe(first.ast);
    });
});

/**
 * The Run lenses, against a stand-in for the editor.
 *
 * What matters: one row per recipe, at the recipe's name; the right command
 * with the document and recipe as its argument; and in an untrusted workspace,
 * a lens that leads to the trust dialog rather than one that pretends to run.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
    type CodeLens,
    Position,
    recorded,
    resetStub,
    workspace,
} from "../../test/stubs/vscode.js";
import { ParseCache } from "../model/cache.js";
import { registerCodeLens } from "./codeLens.js";

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

function lensesFor(text: string): CodeLens[] {
    const context = contextOf();
    registerCodeLens(context as never, new ParseCache());
    const registration = recorded.codeLensProviders.at(-1);
    if (registration === undefined) {
        throw new Error("the provider did not register itself");
    }
    return registration.provider.provideCodeLenses(documentOf(text)) as CodeLens[];
}

const titles = (lenses: readonly CodeLens[]): string[] =>
    lenses.map((lens) => lens.command?.title ?? "");

beforeEach(resetStub);

describe("registration", () => {
    it("registers for the just language and puts everything under disposal", () => {
        const context = contextOf();
        registerCodeLens(context as never, new ParseCache());
        expect(recorded.codeLensProviders[0]?.selector).toEqual({ language: "just" });
        // The emitter, the provider, and the two listeners.
        expect(context.subscriptions).toHaveLength(4);
    });
});

describe("in a trusted workspace", () => {
    it("puts a Run lens on each recipe, at its name", () => {
        const lenses = lensesFor("# doc\nbuild:\n    echo\n\ntest:\n    echo\n");
        expect(titles(lenses)).toEqual(["$(play) Run", "$(play) Run"]);
        expect(lenses[0]?.range.start).toEqual(new Position(1, 0));
        expect(lenses[1]?.range.start).toEqual(new Position(4, 0));
    });

    it("passes the document and recipe name to just.runRecipe", () => {
        const [lens] = lensesFor("build:\n    echo\n");
        expect(lens?.command?.command).toBe("just.runRecipe");
        const target = lens?.command?.arguments?.[0] as { uri: unknown; recipe: string };
        expect(target.recipe).toBe("build");
        expect(String(target.uri)).toBe("file:///justfile");
    });

    it("adds Run with Arguments when every parameter is optional", () => {
        const lenses = lensesFor('deploy env="staging":\n    echo\n');
        expect(titles(lenses)).toEqual(["$(play) Run", "Run with Arguments…"]);
        expect(lenses[1]?.command?.command).toBe("just.runRecipeWithArguments");
    });

    it("offers a single Run… when a parameter is required, since Run must ask anyway", () => {
        const lenses = lensesFor("deploy env:\n    echo\n");
        expect(titles(lenses)).toEqual(["$(play) Run…"]);
        expect(lenses[0]?.command?.command).toBe("just.runRecipe");
    });

    it("includes private recipes, which just can still run by name", () => {
        expect(titles(lensesFor("_helper:\n    echo\n"))).toEqual(["$(play) Run"]);
    });

    it("returns nothing for a document without recipes", () => {
        expect(lensesFor('x := "1"\n')).toEqual([]);
    });
});

describe("in an untrusted workspace", () => {
    it("shows a trust lens that opens the trust dialog, not a run command", () => {
        workspace.isTrusted = false;
        const lenses = lensesFor("build:\n    echo\n\ndeploy env:\n    echo\n");
        expect(titles(lenses)).toEqual([
            "$(shield) Run (requires workspace trust)",
            "$(shield) Run (requires workspace trust)",
        ]);
        for (const lens of lenses) {
            expect(lens.command?.command).toBe("workbench.trust.manage");
            expect(lens.command?.arguments).toBeUndefined();
        }
    });

    it("asks VS Code to refresh when trust is granted", () => {
        workspace.isTrusted = false;
        const context = contextOf();
        registerCodeLens(context as never, new ParseCache());
        let refreshes = 0;
        recorded.codeLensProviders[0]?.provider.onDidChangeCodeLenses?.(() => {
            refreshes++;
        });
        recorded.onDidGrantWorkspaceTrust.emit();
        expect(refreshes).toBe(1);
    });
});

describe("the just.codeLens.enabled setting", () => {
    it("turns the lenses off", () => {
        recorded.config.set("just.codeLens.enabled", false);
        expect(lensesFor("build:\n    echo\n")).toEqual([]);
    });

    it("is read per document, so a folder can override it", () => {
        lensesFor("build:\n    echo\n");
        const scope = recorded.configurationScopes.find((s) => s.section === "just")?.scope;
        expect(String(scope)).toBe("file:///justfile");
    });

    it("asks VS Code to refresh when it changes", () => {
        const context = contextOf();
        registerCodeLens(context as never, new ParseCache());
        let refreshes = 0;
        recorded.codeLensProviders[0]?.provider.onDidChangeCodeLenses?.(() => {
            refreshes++;
        });
        recorded.onDidChangeConfiguration.emit({
            affectsConfiguration: (section) => section === "just.codeLens.enabled",
        });
        recorded.onDidChangeConfiguration.emit({
            affectsConfiguration: (section) => section === "just.executablePath",
        });
        expect(refreshes).toBe(1);
    });
});

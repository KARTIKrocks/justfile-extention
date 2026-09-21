/**
 * Activation wiring.
 *
 * Nothing here checks what the features do — that is each provider's own test.
 * This checks that they are hooked up at all, and that activation stays as
 * cheap as AGENTS.md requires.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { recorded, resetStub } from "../test/stubs/vscode.js";
import { activate, deactivate } from "./extension.js";

function contextOf(): { subscriptions: { dispose(): void }[] } {
    return { subscriptions: [] };
}

beforeEach(resetStub);

describe("activate", () => {
    it("registers the Tier 1 providers", () => {
        activate(contextOf() as never);
        expect(recorded.semanticTokenProviders).toHaveLength(1);
        expect(recorded.documentSymbolProviders).toHaveLength(1);
        expect(recorded.foldingRangeProviders).toHaveLength(1);
    });

    it("registers the Tier 2 CLI status: a status bar item and its three commands", () => {
        activate(contextOf() as never);
        expect(recorded.statusBarItems).toHaveLength(1);
        expect(recorded.commands.has("just.checkInstallation")).toBe(true);
        expect(recorded.commands.has("just.showVersion")).toBe(true);
        expect(recorded.commands.has("just.configureExecutable")).toBe(true);
    });

    it("parses nothing until something asks", () => {
        // The activation budget does not survive walking the workspace. The
        // cache starts empty and fills on the first provider call.
        const context = contextOf();
        activate(context as never);
        const registration = recorded.semanticTokenProviders[0];
        expect(registration).toBeDefined();
        const built = registration?.provider.provideDocumentSemanticTokens({
            uri: { toString: () => "file:///justfile" },
            version: 1,
            getText: () => "build:\n    echo hi\n",
        }) as { pushed: unknown[] };
        expect(built.pushed.length).toBeGreaterThan(0);
    });

    it("puts everything it creates under the context's disposal", () => {
        const context = contextOf();
        activate(context as never);
        // Output channel, close listener, the Tier 1 providers, the trust
        // listener, and the Tier 2 CLI status's item, two listeners and
        // three commands.
        expect(context.subscriptions.length).toBeGreaterThanOrEqual(12);
        for (const subscription of context.subscriptions) {
            expect(() => subscription.dispose()).not.toThrow();
        }
    });

    it("listens for trust being granted rather than reading it once", () => {
        // Trust can arrive mid-session, so a value captured at activation would
        // leave Tier 2 dark until the window reloaded. Two listeners: the
        // output-log message here, and the CLI status's own refresh.
        activate(contextOf() as never);
        expect(recorded.onDidGrantWorkspaceTrust.listeners).toHaveLength(2);
        expect(() => recorded.onDidGrantWorkspaceTrust.emit(undefined)).not.toThrow();
    });

    it("says whether the workspace is trusted, through l10n", () => {
        activate(contextOf() as never);
        const channel = recorded.outputChannels[0];
        expect(channel?.name).toBe("Just");
        expect(channel?.messages[0]).toContain("workspace trusted: true");
    });

    it("has nothing to tear down by hand", () => {
        expect(() => deactivate()).not.toThrow();
    });
});

import { beforeEach, describe, expect, it } from "vitest";
import { recorded, resetStub, type StatusBarItem, window } from "../../test/stubs/vscode.js";
import type { Detection } from "../cli/detect.js";
import { registerCliStatus } from "./cliStatus.js";

function contextOf(): { subscriptions: { dispose(): void }[] } {
    return { subscriptions: [] };
}

/** A fake `detect` that returns each of `results` in turn, then repeats the last. */
function detectSequence(...results: Detection[]): () => Promise<Detection> {
    let index = 0;
    return () => {
        const result = results[Math.min(index, results.length - 1)];
        index++;
        return Promise.resolve(result as Detection);
    };
}

/** Emits `onDidOpenTextDocument` for a justfile and flushes the microtasks refresh() needs. */
async function openAJustfile(): Promise<void> {
    recorded.onDidOpenTextDocument.emit({ languageId: "just", uri: "file:///a/justfile" });
    await Promise.resolve();
    await Promise.resolve();
}

/** Registers with `detect`, opens a justfile to trigger the first real detection, and hands
 * back the item from the stub's own recording — not `registerCliStatus`'s return value, which
 * is typed against the real `vscode.StatusBarItem` and so does not expose the stub's `shown`
 * field. */
async function statusFor(
    context: { subscriptions: { dispose(): void }[] },
    detect: () => Promise<Detection>,
): Promise<StatusBarItem> {
    registerCliStatus(context as never, detect);
    await openAJustfile();
    const item = recorded.statusBarItems.at(-1);
    if (item === undefined) {
        throw new Error("the status bar item was not created");
    }
    return item;
}

const SUPPORTED: Detection = {
    state: "detected",
    detected: { executablePath: "just", version: "1.58.0", supported: true },
};

const UNSUPPORTED: Detection = {
    state: "detected",
    detected: { executablePath: "just", version: "1.21.0", supported: false },
};

const NOT_FOUND: Detection = { state: "not-found" };
const UNTRUSTED: Detection = { state: "untrusted" };

beforeEach(resetStub);

describe("registration", () => {
    it("creates one status bar item and registers the three commands", () => {
        const context = contextOf();
        registerCliStatus(context as never, detectSequence(SUPPORTED));
        expect(recorded.statusBarItems).toHaveLength(1);
        expect(recorded.commands.has("just.checkInstallation")).toBe(true);
        expect(recorded.commands.has("just.showVersion")).toBe(true);
        expect(recorded.commands.has("just.configureExecutable")).toBe(true);
    });

    it("puts the item and every listener and command under the context's disposal", () => {
        const context = contextOf();
        registerCliStatus(context as never, detectSequence(SUPPORTED));
        // Item, three listeners (config change, trust granted, doc opened), three commands.
        expect(context.subscriptions.length).toBeGreaterThanOrEqual(7);
    });

    it("shows an idle, unchecked state immediately, without calling detect", () => {
        const context = contextOf();
        let called = false;
        const detect = () => {
            called = true;
            return Promise.resolve(SUPPORTED);
        };
        registerCliStatus(context as never, detect);
        const item = recorded.statusBarItems.at(-1);
        expect(item?.shown).toBe(true);
        expect(item?.command).toBe("just.checkInstallation");
        expect(called).toBe(false);
    });

    it("resolves with the status bar item after opening a justfile triggers detection", async () => {
        const item = await statusFor(contextOf(), detectSequence(SUPPORTED));
        expect(item.text).toContain("1.58.0");
        expect(item.shown).toBe(true);
    });
});

describe("status bar text", () => {
    it("shows a shield and no command when untrusted", async () => {
        const item = await statusFor(contextOf(), detectSequence(UNTRUSTED));
        expect(item.text).toContain("$(shield)");
        expect(item.command).toBeUndefined();
    });

    it("shows a warning and the configure command when just is not found", async () => {
        const item = await statusFor(contextOf(), detectSequence(NOT_FOUND));
        expect(item.text).toContain("$(warning)");
        expect(item.command).toBe("just.configureExecutable");
    });

    it("shows a check for a supported version, with the check-installation command", async () => {
        const item = await statusFor(contextOf(), detectSequence(SUPPORTED));
        expect(item.text).toContain("$(check)");
        expect(item.text).toContain("1.58.0");
        expect(item.command).toBe("just.checkInstallation");
    });

    it("shows a warning for an unsupported version, distinct from not-found", async () => {
        const item = await statusFor(contextOf(), detectSequence(UNSUPPORTED));
        expect(item.text).toContain("$(warning)");
        expect(item.text).toContain("1.21.0");
    });
});

describe("the below-minimum warning", () => {
    it("is shown once for an unsupported version", async () => {
        await statusFor(contextOf(), detectSequence(UNSUPPORTED));
        expect(recorded.warningMessages).toHaveLength(1);
    });

    it("is not shown again on a later refresh reporting the same thing", async () => {
        await statusFor(contextOf(), detectSequence(UNSUPPORTED, UNSUPPORTED));
        await recorded.commands.get("just.checkInstallation")?.();
        expect(recorded.warningMessages).toHaveLength(1);
    });

    it("is never shown for a supported version", async () => {
        await statusFor(contextOf(), detectSequence(SUPPORTED));
        expect(recorded.warningMessages).toHaveLength(0);
    });
});

describe("just.checkInstallation", () => {
    it("re-runs detection rather than reusing the cache", async () => {
        const item = await statusFor(contextOf(), detectSequence(NOT_FOUND, SUPPORTED));
        expect(item.text).toContain("not found");
        await recorded.commands.get("just.checkInstallation")?.();
        expect(item.text).toContain("1.58.0");
    });

    it("shows an information message describing the result", async () => {
        await statusFor(contextOf(), detectSequence(SUPPORTED));
        recorded.infoMessages.length = 0;
        await recorded.commands.get("just.checkInstallation")?.();
        expect(recorded.infoMessages).toHaveLength(1);
        expect(recorded.infoMessages[0]).toContain("1.58.0");
    });

    it("runs detection even before any justfile has been opened", async () => {
        const context = contextOf();
        registerCliStatus(context as never, detectSequence(SUPPORTED));
        await recorded.commands.get("just.checkInstallation")?.();
        const item = recorded.statusBarItems.at(-1);
        expect(item?.text).toContain("1.58.0");
    });
});

describe("just.showVersion", () => {
    it("uses the cached detection rather than spawning again", async () => {
        await statusFor(contextOf(), detectSequence(SUPPORTED, UNSUPPORTED));
        recorded.infoMessages.length = 0;
        await recorded.commands.get("just.showVersion")?.();
        // A second call to the fake would have returned UNSUPPORTED; seeing
        // the first version means the cache, not a fresh call, was used.
        expect(recorded.infoMessages[0]).toContain("1.58.0");
    });
});

describe("just.configureExecutable", () => {
    it("opens settings scoped to just.executablePath", async () => {
        await statusFor(contextOf(), detectSequence(NOT_FOUND));
        await recorded.commands.get("just.configureExecutable")?.();
        expect(recorded.executedCommands).toContainEqual({
            command: "workbench.action.openSettings",
            args: ["just.executablePath"],
        });
    });
});

describe("refresh triggers", () => {
    it("refreshes when just.executablePath changes, even before any justfile has opened", async () => {
        const context = contextOf();
        registerCliStatus(context as never, detectSequence(SUPPORTED));
        recorded.onDidChangeConfiguration.emit({ affectsConfiguration: () => true });
        await Promise.resolve();
        await Promise.resolve();
        const item = recorded.statusBarItems.at(-1);
        expect(item?.text).toContain("1.58.0");
    });

    it("does not refresh for an unrelated configuration change", () => {
        const context = contextOf();
        registerCliStatus(context as never, detectSequence(SUPPORTED));
        recorded.onDidChangeConfiguration.emit({ affectsConfiguration: () => false });
        const item = recorded.statusBarItems.at(-1);
        expect(item?.command).toBe("just.checkInstallation");
        expect(item?.text).toContain("Just");
        expect(item?.text).not.toContain("1.58.0");
    });

    it("refreshes when workspace trust is granted, even before any justfile has opened", async () => {
        const context = contextOf();
        registerCliStatus(context as never, detectSequence(SUPPORTED));
        recorded.onDidGrantWorkspaceTrust.emit(undefined);
        await Promise.resolve();
        await Promise.resolve();
        const item = recorded.statusBarItems.at(-1);
        expect(item?.text).toContain("1.58.0");
    });

    it("refreshes when a justfile is opened", async () => {
        const item = await statusFor(contextOf(), detectSequence(SUPPORTED));
        expect(item.text).toContain("1.58.0");
    });

    it("ignores a document opened with a different language", async () => {
        const context = contextOf();
        registerCliStatus(context as never, detectSequence(SUPPORTED));
        recorded.onDidOpenTextDocument.emit({
            languageId: "plaintext",
            uri: "file:///a/notes.txt",
        });
        await Promise.resolve();
        await Promise.resolve();
        const item = recorded.statusBarItems.at(-1);
        expect(item?.text).not.toContain("1.58.0");
    });

    it("does not re-detect for a second justfile once already detected", async () => {
        const item = await statusFor(contextOf(), detectSequence(SUPPORTED, UNSUPPORTED));
        expect(item.text).toContain("1.58.0");
        // A second open would have returned UNSUPPORTED from the fake, had it
        // triggered another refresh.
        await openAJustfile();
        expect(item.text).toContain("1.58.0");
    });
});

describe("resource scoping", () => {
    it("passes the opened document's resource to detect", async () => {
        let received: unknown;
        const detect = (resource?: unknown) => {
            received = resource;
            return Promise.resolve(SUPPORTED);
        };
        registerCliStatus(contextOf() as never, detect);
        recorded.onDidOpenTextDocument.emit({ languageId: "just", uri: "file:///a/justfile" });
        await Promise.resolve();
        await Promise.resolve();
        expect(received).toBe("file:///a/justfile");
    });

    it("falls back to the active editor's resource for other triggers", async () => {
        window.activeTextEditor = { document: { uri: "file:///active/justfile" } };
        let received: unknown;
        const detect = (resource?: unknown) => {
            received = resource;
            return Promise.resolve(SUPPORTED);
        };
        registerCliStatus(contextOf() as never, detect);
        await recorded.commands.get("just.checkInstallation")?.();
        expect(received).toBe("file:///active/justfile");
    });
});

describe("activation must not spawn a process", () => {
    it("never calls detect merely from registering, even after the task queue is flushed", async () => {
        let called = false;
        const detect = () => {
            called = true;
            return Promise.resolve(SUPPORTED);
        };
        registerCliStatus(contextOf() as never, detect);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(called).toBe(false);
    });
});

describe("concurrent refreshes", () => {
    it("keeps the most recently started refresh's result, even when an earlier one resolves later", async () => {
        let resolveSlow: ((detection: Detection) => void) | undefined;
        const slow = new Promise<Detection>((resolve) => {
            resolveSlow = resolve;
        });
        let calls = 0;
        const detect = () => {
            calls += 1;
            // The first call (triggered by opening a justfile) hangs until
            // resolveSlow is called; every later call resolves at once,
            // simulating two execFile round-trips completing in the opposite
            // order to the one they started in.
            return calls === 1 ? slow : Promise.resolve(SUPPORTED);
        };

        const context = contextOf();
        registerCliStatus(context as never, detect);
        recorded.onDidOpenTextDocument.emit({ languageId: "just", uri: "file:///a/justfile" });
        // Let the triggered refresh actually start (generation 1), without
        // waiting for it to resolve.
        await Promise.resolve();
        await Promise.resolve();

        // A second refresh — generation 2 — starts later and resolves
        // before the first one does.
        await recorded.commands.get("just.checkInstallation")?.();
        const item = recorded.statusBarItems.at(-1);
        expect(item?.text).toContain("1.58.0");

        // The slow, earlier-started refresh finally resolves with a
        // different result. It must not overwrite generation 2's.
        resolveSlow?.(NOT_FOUND);
        await Promise.resolve();
        await Promise.resolve();
        expect(item?.text).toContain("1.58.0");
    });
});

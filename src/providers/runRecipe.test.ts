/**
 * The run commands, against a stand-in for the editor.
 *
 * The order of checks is the subject here as much as the outcome: trust
 * before anything else, then the document, then the recipe, then the
 * questions — and a cancelled question runs nothing.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
    recorded,
    resetStub,
    ShellQuoting,
    type Task,
    TaskScope,
    type TextDocumentStub,
    window,
    workspace,
} from "../../test/stubs/vscode.js";
import { ParseCache } from "../model/cache.js";
import { registerRunRecipe } from "./runRecipe.js";

const URI = "file:///w/justfile";

function documentOf(text: string, overrides: Partial<TextDocumentStub> = {}): TextDocumentStub {
    let saved = false;
    const base = {
        languageId: "just",
        uri: { toString: () => URI, scheme: "file", fsPath: "/w/justfile" },
        version: 1,
        isDirty: false,
        getText: () => text,
        save: () => {
            saved = true;
            return Promise.resolve(true);
        },
        get wasSaved() {
            return saved;
        },
    };
    // Descriptors rather than a spread, so an override written as a getter
    // stays live instead of being read once.
    return Object.defineProperties(
        base,
        Object.getOwnPropertyDescriptors(overrides),
    ) as TextDocumentStub;
}

/** Register, open `text` as the active Justfile, and hand back the commands. */
function setUp(text: string, overrides: Partial<TextDocumentStub> = {}) {
    const context = { subscriptions: [] as { dispose(): void }[] };
    registerRunRecipe(context as never, new ParseCache());
    const document = documentOf(text, overrides);
    workspace.openDocuments.set(URI, document);
    window.activeTextEditor = { document };
    const run = recorded.commands.get("just.runRecipe");
    const runWith = recorded.commands.get("just.runRecipeWithArguments");
    if (run === undefined || runWith === undefined) {
        throw new Error("the commands did not register");
    }
    return { context, document, run, runWith };
}

const target = (recipe: string) => ({ uri: { toString: () => URI }, recipe });

function lastTask(): Task {
    const task = recorded.executedTasks.at(-1);
    if (task === undefined) {
        throw new Error("no task was executed");
    }
    return task;
}

const argValues = (task: Task): string[] =>
    task.execution.args.map((arg) => (typeof arg === "string" ? arg : arg.value));

beforeEach(resetStub);

describe("registration", () => {
    it("registers both commands under the context's disposal", () => {
        const { context } = setUp("build:\n    echo\n");
        expect(context.subscriptions).toHaveLength(2);
        expect([...recorded.commands.keys()]).toEqual([
            "just.runRecipe",
            "just.runRecipeWithArguments",
        ]);
    });
});

describe("trust", () => {
    it("refuses before reading the document or asking anything", async () => {
        workspace.isTrusted = false;
        const { run } = setUp("deploy env:\n    echo\n");
        await run(target("deploy"));
        expect(recorded.executedTasks).toEqual([]);
        expect(recorded.inputBoxPrompts).toEqual([]);
        expect(recorded.warningMessages).toHaveLength(1);
        expect(recorded.warningMessages[0]).toMatch(/trusted workspace/);
    });
});

describe("running from a CodeLens target", () => {
    it("runs the named recipe as a task with an explicit justfile and directory", async () => {
        const { run } = setUp("build:\n    echo\n");
        await run(target("build"));
        const task = lastTask();
        expect(task.execution.command).toEqual({ value: "just", quoting: ShellQuoting.Strong });
        expect(argValues(task)).toEqual([
            "--justfile",
            "/w/justfile",
            "--working-directory",
            "/w",
            "build",
        ]);
        expect(task.execution.options?.cwd).toBe("/w");
        expect(task.name).toBe("just build");
        expect(task.definition).toEqual({ type: "just", recipe: "build" });
    });

    it("quotes every argument strongly, so the shell never interprets one", async () => {
        const { run } = setUp("build:\n    echo\n");
        await run(target("build"));
        for (const arg of lastTask().execution.args) {
            expect(typeof arg).toBe("object");
            expect((arg as { quoting: number }).quoting).toBe(ShellQuoting.Strong);
        }
    });

    it("uses the configured executable for that resource", async () => {
        recorded.config.set("just.executablePath", "/opt/just");
        const { run } = setUp("build:\n    echo\n");
        await run(target("build"));
        expect(lastTask().execution.command).toEqual({
            value: "/opt/just",
            quoting: ShellQuoting.Strong,
        });
    });

    it("shows an error when the task system cannot start the run", async () => {
        recorded.taskLaunchError = new Error("no terminal");
        const { run } = setUp("build:\n    echo\n");
        await run(target("build"));
        expect(recorded.errorMessages[0]).toMatch(/Could not start just build: no terminal/);
    });

    it("scopes the task to the workspace folder when there is one", async () => {
        workspace.workspaceFolder = { uri: "file:///w", name: "w", index: 0 };
        const { run } = setUp("build:\n    echo\n");
        await run(target("build"));
        expect(lastTask().scope).toBe(workspace.workspaceFolder);
    });

    it("falls back to the workspace scope for a file outside every folder", async () => {
        const { run } = setUp("build:\n    echo\n");
        await run(target("build"));
        expect(lastTask().scope).toBe(TaskScope.Workspace);
    });

    it("warns and runs nothing for a recipe that is not in the file", async () => {
        const { run } = setUp("build:\n    echo\n");
        await run(target("nope"));
        expect(recorded.executedTasks).toEqual([]);
        expect(recorded.warningMessages[0]).toMatch(/nope/);
    });

    it("saves a dirty document first, since just reads the disk", async () => {
        const { run, document } = setUp("build:\n    echo\n", { isDirty: true });
        await run(target("build"));
        expect((document as { wasSaved?: boolean }).wasSaved).toBe(true);
        expect(recorded.executedTasks).toHaveLength(1);
    });

    it("refuses to run when saving changed the recipe's parameters", async () => {
        // A save participant (a formatter, say) rewrote the file so that the
        // arguments collected no longer fit.
        let text = "deploy env:\n    echo\n";
        let version = 1;
        const { run } = setUp(text, {
            isDirty: true,
            getText: () => text,
            get version() {
                return version;
            },
            save: () => {
                // An edit, so the version moves — as it does in the editor.
                text = 'deploy env region="eu":\n    echo\n';
                version++;
                return Promise.resolve(true);
            },
        });
        recorded.inputBoxAnswers.push("prod");
        await run(target("deploy"));
        expect(recorded.executedTasks).toEqual([]);
        expect(recorded.warningMessages[0]).toMatch(/changed while preparing to run deploy/);
    });

    it("refuses to run when saving removed the recipe", async () => {
        let text = "build:\n    echo\n";
        let version = 1;
        const { run } = setUp(text, {
            isDirty: true,
            getText: () => text,
            get version() {
                return version;
            },
            save: () => {
                text = "test:\n    echo\n";
                version++;
                return Promise.resolve(true);
            },
        });
        await run(target("build"));
        expect(recorded.executedTasks).toEqual([]);
        expect(recorded.warningMessages[0]).toMatch(/changed while preparing/);
    });

    it("refuses an untitled document, which has no path for just to read", async () => {
        const { run } = setUp("build:\n    echo\n", {
            uri: { toString: () => "untitled:Untitled-1", scheme: "untitled" },
        });
        workspace.openDocuments.set(
            "untitled:Untitled-1",
            window.activeTextEditor?.document as never,
        );
        await run(undefined);
        expect(recorded.executedTasks).toEqual([]);
        expect(recorded.warningMessages[0]).toMatch(/Save/);
    });
});

describe("running from the Command Palette", () => {
    it("offers the active Justfile's recipes and runs the chosen one", async () => {
        const { run } = setUp("# Build it\nbuild:\n    echo\n\ntest:\n    echo\n");
        recorded.quickPickAnswers.push("test");
        await run(undefined);
        expect(recorded.quickPickItems[0]?.map((item) => [item.label, item.description])).toEqual([
            ["build", "Build it"],
            ["test", ""],
        ]);
        expect(argValues(lastTask()).at(-1)).toBe("test");
    });

    it("runs nothing when the pick is dismissed", async () => {
        const { run } = setUp("build:\n    echo\n");
        recorded.quickPickAnswers.push(undefined);
        await run(undefined);
        expect(recorded.executedTasks).toEqual([]);
    });

    it("warns when no Justfile is active", async () => {
        const { run } = setUp("build:\n    echo\n");
        window.activeTextEditor = { document: { languageId: "typescript", uri: "file:///a.ts" } };
        await run(undefined);
        expect(recorded.executedTasks).toEqual([]);
        expect(recorded.warningMessages[0]).toMatch(/Open a Justfile/);
    });

    it("says so when the Justfile has no recipes", async () => {
        const { run } = setUp('x := "1"\n');
        await run(undefined);
        expect(recorded.executedTasks).toEqual([]);
        expect(recorded.infoMessages[0]).toMatch(/no recipes/);
    });
});

describe("arguments", () => {
    it("asks nothing for Run on a recipe whose parameters all have defaults", async () => {
        const { run } = setUp('deploy env="staging":\n    echo\n');
        await run(target("deploy"));
        expect(recorded.inputBoxPrompts).toEqual([]);
        expect(argValues(lastTask()).slice(-1)).toEqual(["deploy"]);
    });

    it("asks for a required parameter even on plain Run", async () => {
        const { run } = setUp("deploy env:\n    echo\n");
        recorded.inputBoxAnswers.push("prod");
        await run(target("deploy"));
        expect(recorded.inputBoxPrompts).toEqual(["env"]);
        expect(argValues(lastTask()).slice(-2)).toEqual(["deploy", "prod"]);
    });

    it("asks for every parameter on Run with Arguments", async () => {
        const { runWith } = setUp('deploy env version="latest":\n    echo\n');
        recorded.inputBoxAnswers.push("prod", "1.2");
        await runWith(target("deploy"));
        expect(recorded.inputBoxPrompts).toEqual([
            "env",
            "version (leave empty to use its default)",
        ]);
        expect(argValues(lastTask()).slice(-3)).toEqual(["deploy", "prod", "1.2"]);
    });

    it("stops at the first optional parameter left empty, omitting it and the rest", async () => {
        const { runWith } = setUp('r a b="x" c="y":\n    echo\n');
        recorded.inputBoxAnswers.push("1", "");
        await runWith(target("r"));
        expect(recorded.inputBoxPrompts).toHaveLength(2);
        expect(argValues(lastTask()).slice(-2)).toEqual(["r", "1"]);
    });

    it("collects a variadic one value at a time, each its own argument", async () => {
        const { run } = setUp("test +files:\n    echo\n");
        recorded.inputBoxAnswers.push("a.go", "b c.go", "");
        await run(target("test"));
        expect(recorded.inputBoxPrompts).toHaveLength(3);
        expect(argValues(lastTask()).slice(-3)).toEqual(["test", "a.go", "b c.go"]);
    });

    it("lets a `*` variadic be empty", async () => {
        const { runWith } = setUp("test *files:\n    echo\n");
        recorded.inputBoxAnswers.push("");
        await runWith(target("test"));
        expect(argValues(lastTask()).slice(-1)).toEqual(["test"]);
    });

    it("runs nothing when a question is cancelled", async () => {
        const { run } = setUp("deploy env:\n    echo\n");
        recorded.inputBoxAnswers.push(undefined);
        await run(target("deploy"));
        expect(recorded.executedTasks).toEqual([]);
    });

    it("runs nothing when a later variadic value is cancelled", async () => {
        const { run } = setUp("test +files:\n    echo\n");
        recorded.inputBoxAnswers.push("a.go", undefined);
        await run(target("test"));
        expect(recorded.executedTasks).toEqual([]);
    });
});

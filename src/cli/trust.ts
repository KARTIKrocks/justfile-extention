/**
 * The single point every `just` subprocess spawn must go through.
 *
 * Tier 2. See AGENTS.md invariant 2: reading a Justfile with the CLI is
 * itself execution — backticks and `shell()` run at parse time — so no
 * feature module may call `child_process` on its own. Every call lands here,
 * where trust is checked fresh, not cached from activation, because a user
 * can grant trust mid-session and a stale "untrusted" reading would leave
 * Tier 2 dark longer than it needs to be.
 *
 * There are two ways out of this module and both check trust first:
 * `runJust` for a captured, bounded subprocess (`--version`, `--dump`), and
 * `startJustTask` for a recipe run the user watches in the terminal. The
 * second is not `child_process` — VS Code owns that process — but it is
 * still `just` executing a Justfile, so it lives here and nowhere else.
 *
 * This module is not itself the trust *policy* — it does not decide which
 * executable path to use, only refuses to run one when untrusted. Deciding
 * that a workspace-level `just.executablePath` must be ignored when
 * untrusted is `src/cli/detect.ts`'s job, made moot in practice today by the
 * stronger rule here: nothing runs at all until the workspace is trusted, so
 * an untrusted-workspace path is never reached regardless of its source.
 */

import { execFile } from "node:child_process";
import * as vscode from "vscode";

export type JustOutcome =
    | { readonly ok: true; readonly stdout: string }
    | { readonly ok: false; readonly reason: "untrusted" }
    | { readonly ok: false; readonly reason: "spawn-error"; readonly message: string };

const TIMEOUT_MS = 10_000;

/**
 * Run `just` with `args`. Resolves, never rejects — a failed spawn is data,
 * not an exception, so callers do not need a try/catch around every use.
 */
export function runJust(executablePath: string, args: readonly string[]): Promise<JustOutcome> {
    if (!vscode.workspace.isTrusted) {
        return Promise.resolve({ ok: false, reason: "untrusted" });
    }
    return new Promise((resolve) => {
        execFile(executablePath, args, { timeout: TIMEOUT_MS }, (error, stdout, stderr) => {
            if (error) {
                resolve({
                    ok: false,
                    reason: "spawn-error",
                    message: stderr.trim() || error.message,
                });
                return;
            }
            resolve({ ok: true, stdout });
        });
    });
}

export type TaskOutcome =
    | { readonly ok: true; readonly execution: vscode.TaskExecution }
    | { readonly ok: false; readonly reason: "untrusted" };

export interface TaskOptions {
    /** Directory the terminal starts in. `just` gets an explicit one too. */
    readonly cwd: string;
    /** The workspace folder the run belongs to, for task scoping. */
    readonly scope: vscode.WorkspaceFolder | vscode.TaskScope;
    /** Shown as the terminal's name: `just build`. */
    readonly label: string;
    /** `just`-specific identity, so "Rerun Last Task" knows what it was. */
    readonly recipe: string;
}

/**
 * Run `just` with `args` in the integrated terminal, as a VS Code task.
 *
 * A task rather than `terminal.sendText`, for three reasons that all matter
 * here. `ShellExecution` takes an argv array and quotes every element for
 * the shell the terminal actually runs, so an argument containing a space
 * or a quote is never spliced into a command string by us (PRD §Execution
 * surface: "never build a shell string through concatenation"). The task
 * terminal shows the exit code and stays open to be read. And the task
 * system already provides reuse, "Rerun Last Task" and termination, none of
 * which has to be rebuilt.
 *
 * Resolves, never rejects, like `runJust`. An untrusted workspace is a
 * result, not an error, and the caller is expected to have checked before
 * asking the user anything — this check is the backstop, not the policy.
 */
export async function startJustTask(
    executablePath: string,
    args: readonly string[],
    options: TaskOptions,
): Promise<TaskOutcome> {
    if (!vscode.workspace.isTrusted) {
        return { ok: false, reason: "untrusted" };
    }
    // Strong quoting on every element: literal, no expansion, whatever the
    // shell. The executable is left as written so a bare `just` still
    // resolves on PATH.
    const quoted = args.map((value) => ({ value, quoting: vscode.ShellQuoting.Strong }));
    const execution = new vscode.ShellExecution(executablePath, quoted, { cwd: options.cwd });
    const task = new vscode.Task(
        { type: TASK_TYPE, recipe: options.recipe },
        options.scope,
        options.label,
        TASK_SOURCE,
        execution,
    );
    task.presentationOptions = {
        reveal: vscode.TaskRevealKind.Always,
        panel: vscode.TaskPanelKind.Shared,
        clear: false,
        showReuseMessage: true,
    };
    return { ok: true, execution: await vscode.tasks.executeTask(task) };
}

/** Matches `contributes.taskDefinitions` in package.json. */
export const TASK_TYPE = "just";
/** What the task terminal is attributed to. */
export const TASK_SOURCE = "just";

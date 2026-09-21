/**
 * The status bar item behind PRD 8.29, and the three commands from its
 * command-palette list: `Just: Check Just Installation`, `Just: Show Just
 * Version`, `Just: Configure Just Executable`.
 *
 * Tier 2: every path through here either reads workspace configuration or,
 * through `detectJust`/`runJust`, may spawn `just --version`. Nothing here
 * calls `child_process` directly — see `src/cli/trust.ts`.
 */

import * as vscode from "vscode";
import { type Detection, detectJust } from "../cli/detect.js";
import { MINIMUM_SUPPORTED_VERSION } from "../cli/version.js";

const CONFIGURE_COMMAND = "just.configureExecutable";
const CHECK_COMMAND = "just.checkInstallation";
const SHOW_VERSION_COMMAND = "just.showVersion";

function applyDetection(item: vscode.StatusBarItem, detection: Detection): void {
    switch (detection.state) {
        case "untrusted":
            item.text = `$(shield) ${vscode.l10n.t("Just")}`;
            item.tooltip = vscode.l10n.t(
                "This workspace is not trusted, so just is not run. Diagnostics, formatting and recipe execution stay unavailable until trust is granted.",
            );
            item.command = undefined;
            break;
        case "not-found":
            item.text = `$(warning) ${vscode.l10n.t("Just: not found")}`;
            item.tooltip = vscode.l10n.t(
                "just was not found. Install it, or set just.executablePath to where it lives.",
            );
            item.command = CONFIGURE_COMMAND;
            break;
        case "detected": {
            const { version, supported } = detection.detected;
            item.text = supported
                ? `$(check) ${vscode.l10n.t("Just {0}", version)}`
                : `$(warning) ${vscode.l10n.t("Just {0}", version)}`;
            item.tooltip = supported
                ? vscode.l10n.t("just {0}, at {1}.", version, detection.detected.executablePath)
                : vscode.l10n.t(
                      "just {0}, at {1}, is older than the minimum supported version, {2}. Some features may not work correctly.",
                      version,
                      detection.detected.executablePath,
                      MINIMUM_SUPPORTED_VERSION,
                  );
            item.command = CHECK_COMMAND;
            break;
        }
    }
    item.show();
}

function messageFor(detection: Detection): string {
    switch (detection.state) {
        case "untrusted":
            return vscode.l10n.t("This workspace is not trusted, so just was not run.");
        case "not-found":
            return vscode.l10n.t(
                "just was not found. Install it, or set just.executablePath to where it lives.",
            );
        case "detected": {
            const { version, executablePath, supported } = detection.detected;
            return supported
                ? vscode.l10n.t("just {0}, at {1}.", version, executablePath)
                : vscode.l10n.t(
                      "just {0}, at {1}, is older than the minimum supported version, {2}.",
                      version,
                      executablePath,
                      MINIMUM_SUPPORTED_VERSION,
                  );
        }
    }
}

export function registerCliStatus(
    context: vscode.ExtensionContext,
    detect: () => Promise<Detection> = detectJust,
): Promise<vscode.StatusBarItem> {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    context.subscriptions.push(item);

    // Cached between the triggers PRD 8.29 names — a config change, trust
    // being granted, or the explicit "check installation" command — rather
    // than re-spawned on every read.
    let cached: Detection | undefined;
    // Shown once per session: PRD 8.29 says the extension "states this
    // clearly once, and does not repeatedly nag."
    let warnedBelowMinimum = false;
    // The four triggers below can each start a refresh without waiting for
    // an earlier one to finish (config change and trust-granted racing each
    // other, say), and their `detect()` calls have no ordering guarantee on
    // which resolves last. Only the most recently *started* refresh may
    // update the cache and the status bar, so a slower, superseded one
    // cannot overwrite a newer result with a stale one. The caller still
    // gets its own call's actual result back, for a command like "check
    // installation" to report on — only the shared state is guarded.
    let generation = 0;

    async function refresh(): Promise<Detection> {
        const thisGeneration = ++generation;
        const detection = await detect();
        if (thisGeneration === generation) {
            cached = detection;
            applyDetection(item, detection);
            if (
                detection.state === "detected" &&
                !detection.detected.supported &&
                !warnedBelowMinimum
            ) {
                warnedBelowMinimum = true;
                void vscode.window.showWarningMessage(messageFor(detection));
            }
        }
        return detection;
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("just.executablePath")) {
                void refresh();
            }
        }),
        vscode.workspace.onDidGrantWorkspaceTrust(() => {
            void refresh();
        }),
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(CHECK_COMMAND, async () => {
            const detection = await refresh();
            void vscode.window.showInformationMessage(messageFor(detection));
        }),
        vscode.commands.registerCommand(SHOW_VERSION_COMMAND, async () => {
            const detection = cached ?? (await refresh());
            void vscode.window.showInformationMessage(messageFor(detection));
        }),
        vscode.commands.registerCommand(CONFIGURE_COMMAND, () => {
            void vscode.commands.executeCommand(
                "workbench.action.openSettings",
                "just.executablePath",
            );
        }),
    );

    // Deferred past the current synchronous call: `refresh` reaches
    // `runJust`, whose `new Promise((resolve) => execFile(...))` executor
    // runs synchronously, per the language — without this yield, the actual
    // subprocess spawn would happen inside activate()'s own call stack,
    // before it returns. AGENTS.md invariant 5 forbids that outright, and
    // nothing in CI would catch it if it crept back in.
    return Promise.resolve()
        .then(refresh)
        .then(() => item);
}

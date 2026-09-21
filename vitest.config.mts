import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The extension host is not available under vitest, so the provider layer gets
 * a stand-in. Type checking still runs against the real `@types/vscode`; this
 * only swaps the module at run time.
 */
const vscodeStub = fileURLToPath(new URL("./test/stubs/vscode.ts", import.meta.url));

export default defineConfig({
    test: {
        projects: [
            {
                test: {
                    name: "unit",
                    include: ["src/**/*.test.ts", "test/grammar/**/*.test.ts"],
                    environment: "node",
                },
                resolve: { alias: { vscode: vscodeStub } },
            },
            {
                test: {
                    name: "differential",
                    include: ["test/differential/**/*.test.ts"],
                    environment: "node",
                    // Each case shells out to the just binary.
                    testTimeout: 30_000,
                },
                // trust.test.ts imports src/cli/trust.ts, which reads
                // `vscode.workspace.isTrusted`. Everything else here is
                // vscode-free; the stub's default (trusted) is what this
                // project's tests want anyway.
                resolve: { alias: { vscode: vscodeStub } },
            },
        ],
    },
});

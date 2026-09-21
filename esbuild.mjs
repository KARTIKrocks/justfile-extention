import esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * The extension runs in VS Code's Node host, so `vscode` is provided by the host
 * and must never be bundled. Everything else is bundled into a single file: the
 * activation budget in AGENTS.md does not survive a module graph.
 */
const options = {
    entryPoints: ["src/extension.ts"],
    bundle: true,
    outfile: "dist/extension.js",
    external: ["vscode"],
    format: "cjs",
    platform: "node",
    target: "node20",
    sourcemap: !production,
    minify: production,
    logLevel: "info",
};

if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
} else {
    const result = await esbuild.build({ ...options, metafile: true });
    const bytes = Object.values(result.metafile.outputs)[0].bytes;
    const kb = (bytes / 1024).toFixed(1);
    console.log(`bundle: ${kb} KB`);

    // Budget from AGENTS.md. Enforced here so a local build fails the same way CI does.
    const LIMIT_KB = 300;
    if (production && bytes > LIMIT_KB * 1024) {
        console.error(`bundle exceeds the ${LIMIT_KB} KB budget (${kb} KB)`);
        process.exit(1);
    }
}

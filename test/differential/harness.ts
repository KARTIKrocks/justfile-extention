/**
 * Differential test harness.
 *
 * Parses a fixture with our parser and with `just --dump --dump-format json`,
 * reduces both to the same comparable shape, and reports any disagreement.
 * When the two disagree, `just` is right. See AGENTS.md.
 *
 * This is test-only code and therefore Tier 2 by definition: it spawns `just`.
 * The fixtures are files we control. Note that just evaluates backticks and
 * `shell()` at parse time, so a fixture containing either would execute during
 * the test run — fixtures must stay free of side effects.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { versionAtLeast } from "../../src/cli/version.js";
import { modelFromSource } from "../../src/model/build.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(HERE, "fixtures");

/** The shape both sides are reduced to. Structure only — never evaluated values. */
export interface ComparableParameter {
    readonly name: string;
    readonly kind: string;
    readonly export: boolean;
    /**
     * Whether a default was written, not what it evaluates to. The dump reports
     * defaults as `"lit"`, `["variable", "v"]` or `["evaluate", "echo x"]`; the
     * last needs a subprocess to resolve, which Tier 1 must never do.
     */
    readonly hasDefault: boolean;
}

export interface ComparableRecipe {
    readonly name: string;
    readonly parameters: readonly ComparableParameter[];
    /** Prior dependencies followed by `&&` subsequents, matching the dump's order. */
    readonly dependencies: ReadonlyArray<{ recipe: string; argumentCount: number }>;
    readonly priors: number;
    readonly attributes: readonly string[];
    readonly doc: string | null;
    readonly quiet: boolean;
    readonly shebang: boolean;
    readonly private: boolean;
}

export interface ComparableAssignment {
    readonly name: string;
    readonly export: boolean;
    /** Omitted when the installed `just` does not report it. See DumpCapabilities. */
    readonly private?: boolean;
}

export interface Comparable {
    readonly recipes: readonly ComparableRecipe[];
    readonly assignments: readonly ComparableAssignment[];
    readonly aliases: ReadonlyArray<{ name: string; target: string }>;
    /**
     * Settings the file sets, named as the dump spells them (snake_case).
     *
     * The dump always reports every setting with its resolved value, so it never
     * says which ones the file wrote. The set is recovered by diffing against
     * the defaults for the same binary — see `explicitSettings`.
     */
    readonly settings: readonly string[];
    /**
     * The values of the string-list settings, keyed as the dump spells them.
     *
     * This is the only place a setting's *value* is compared, and it exists
     * because it is the only setting value both sides can know without
     * evaluating anything. It is what gives a list literal real coverage here:
     * the dump reports `shell` as `{command, arguments}`, so a parser that
     * dropped an element or split them wrongly disagrees.
     *
     * One asymmetry to know about, shared with `settings`. The dump reports
     * only settings whose value differs from the default, because nothing in it
     * says which ones the file wrote; our side reports every list it read.
     * `set shell := ["sh", "-cu"]` in a fixture therefore *fails* the suite
     * rather than comparing nothing, and the failure looks like a parser bug
     * when it is a fixture that set a setting to its own default. The parser
     * side cannot filter to match: knowing just's defaults means running just,
     * which is the one thing Tier 1 must not do.
     */
    readonly stringLists: Readonly<Record<string, readonly string[]>>;
    readonly modules: readonly string[];
    readonly first: string | null;
}

/**
 * The settings whose value is a list of strings.
 *
 * `script_interpreter` arrived in just 1.33.0 and is simply absent from an
 * older dump, which needs no capability flag: an absent key is not explicitly
 * set, so neither side reports it.
 */
const STRING_LIST_SETTINGS = ["shell", "windows_shell", "script_interpreter"] as const;

/**
 * Imports are deliberately absent from Comparable.
 *
 * `just` inlines an imported file, so its recipes appear in the importing
 * file's `recipes` as though they had been written there. Our parser does no
 * I/O and never opens the imported file, so the two can never agree on a
 * fixture that imports. Covering imports needs a harness that resolves them
 * first, which is a separate piece of work; until then a fixture using
 * `import` would fail for a reason that is not a parser defect.
 */

// ---------------------------------------------------------------------------
// The just CLI
// ---------------------------------------------------------------------------

export function justBinary(): string {
    return process.env["JUST_BINARY"] ?? "just";
}

export function justVersion(): string {
    const output = execFileSync(justBinary(), ["--version"], { encoding: "utf8" });
    return output.trim().replace(/^just\s+/, "");
}

export { MINIMUM_SUPPORTED_VERSION, versionAtLeast } from "../../src/cli/version.js";

/**
 * What the installed `just` actually reports, so the comparison never asserts
 * something the CLI never said.
 *
 * Coercing a missing field to a default is the subtle way a differential test
 * stops being differential: it turns "just is silent about this" into "just
 * says false", and then fails our parser for disagreeing with a value that was
 * never there.
 */
export interface DumpCapabilities {
    /**
     * `private` on assignments. Absent before 1.35.0 — established by bisecting
     * the real binaries, not from the changelog, which documents only the
     * `[private]` attribute and not the underscore convention.
     */
    readonly assignmentPrivate: boolean;
}

export function capabilitiesFor(version: string): DumpCapabilities {
    return { assignmentPrivate: versionAtLeast(version, "1.35.0") };
}

export interface DumpResult {
    readonly ok: boolean;
    readonly json?: unknown;
    readonly stderr?: string;
}

export function dumpWithJust(file: string): DumpResult {
    try {
        const stdout = execFileSync(
            justBinary(),
            [
                "--justfile",
                file,
                "--working-directory",
                dirname(file),
                "--dump",
                "--dump-format",
                "json",
            ],
            { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] },
        );
        return { ok: true, json: JSON.parse(stdout) };
    } catch (error) {
        const stderr =
            error instanceof Error && "stderr" in error
                ? String((error as { stderr?: unknown }).stderr ?? error.message)
                : String(error);
        return { ok: false, stderr };
    }
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Render one dump attribute as `name` or `name(arg,arg)`.
 *
 * The dump emits a bare string for an attribute with no arguments and a
 * single-key object otherwise, with the value either a string or an array.
 */
function attributeToString(entry: unknown): string {
    if (typeof entry === "string") {
        return entry;
    }
    const record = asRecord(entry);
    const name = Object.keys(record)[0];
    if (name === undefined) {
        return "";
    }
    const value = record[name];
    if (value === null || value === undefined) {
        return name;
    }
    const args = Array.isArray(value) ? value.map(String) : [String(value)];
    return `${name}(${args.join(",")})`;
}

/**
 * The settings this binary reports for a file that sets nothing.
 *
 * Read from `just` itself rather than hard-coded, so the baseline tracks
 * whatever version is under test instead of drifting as defaults change.
 * Cached: it is the same for every fixture in a run.
 */
let defaultSettingsCache: Record<string, unknown> | undefined;

function defaultSettings(): Record<string, unknown> {
    if (defaultSettingsCache === undefined) {
        // An empty file on disk, not `--justfile -`. Reading a justfile from
        // stdin is a recent capability: just 1.40.0 and earlier treat `-` as a
        // literal filename and fail with "No such file or directory".
        const dir = mkdtempSync(join(tmpdir(), "just-defaults-"));
        try {
            const file = join(dir, "justfile");
            writeFileSync(file, "");
            const stdout = execFileSync(
                justBinary(),
                ["--justfile", file, "--working-directory", dir, "--dump", "--dump-format", "json"],
                { encoding: "utf8", timeout: 15_000 },
            );
            defaultSettingsCache = asRecord(asRecord(JSON.parse(stdout))["settings"]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }
    return defaultSettingsCache;
}

/**
 * Which settings the file actually set, recovered by diffing against defaults.
 *
 * A setting written with its own default value (`set dotenv-load := false`) is
 * invisible to this and will not be compared. Nothing in the dump distinguishes
 * that case, so the alternative is not a better comparison but a fabricated one.
 */
function explicitSettings(dumpSettings: Record<string, unknown>): string[] {
    const defaults = defaultSettings();
    return Object.keys(dumpSettings)
        .filter((key) => JSON.stringify(dumpSettings[key]) !== JSON.stringify(defaults[key]))
        .sort();
}

/** just spells settings in snake_case in the dump; the language uses kebab-case. */
function settingKey(name: string): string {
    return name.replaceAll("-", "_");
}

export function comparableFromDump(dump: unknown, caps: DumpCapabilities): Comparable {
    const root = asRecord(dump);
    const recipesRecord = asRecord(root["recipes"]);

    const recipes = Object.values(recipesRecord)
        .map((raw): ComparableRecipe => {
            const r = asRecord(raw);
            const parameters = (Array.isArray(r["parameters"]) ? r["parameters"] : []).map((p) => {
                const param = asRecord(p);
                return {
                    name: String(param["name"] ?? ""),
                    kind: String(param["kind"] ?? "singular"),
                    export: param["export"] === true,
                    hasDefault: param["default"] !== null && param["default"] !== undefined,
                };
            });
            const dependencies = (Array.isArray(r["dependencies"]) ? r["dependencies"] : []).map(
                (d) => {
                    const dep = asRecord(d);
                    const args = dep["arguments"];
                    return {
                        recipe: String(dep["recipe"] ?? ""),
                        argumentCount: Array.isArray(args) ? args.length : 0,
                    };
                },
            );
            const attributes = (Array.isArray(r["attributes"]) ? r["attributes"] : [])
                .map(attributeToString)
                .sort();
            return {
                name: String(r["name"] ?? ""),
                parameters,
                dependencies,
                priors: typeof r["priors"] === "number" ? r["priors"] : 0,
                attributes,
                doc: typeof r["doc"] === "string" ? r["doc"] : null,
                quiet: r["quiet"] === true,
                shebang: r["shebang"] === true,
                private: r["private"] === true,
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

    const assignments = Object.values(asRecord(root["assignments"]))
        .map((raw): ComparableAssignment => {
            const a = asRecord(raw);
            return {
                name: String(a["name"] ?? ""),
                export: a["export"] === true,
                ...(caps.assignmentPrivate ? { private: a["private"] === true } : {}),
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

    const aliases = Object.values(asRecord(root["aliases"]))
        .map((raw) => {
            const a = asRecord(raw);
            return { name: String(a["name"] ?? ""), target: String(a["target"] ?? "") };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

    const dumpSettings = asRecord(root["settings"]);
    const settings = explicitSettings(dumpSettings);
    const stringLists: Record<string, readonly string[]> = {};
    for (const key of STRING_LIST_SETTINGS) {
        if (!settings.includes(key)) {
            continue;
        }
        const setting = asRecord(dumpSettings[key]);
        const args = Array.isArray(setting["arguments"]) ? setting["arguments"].map(String) : [];
        stringLists[key] = [String(setting["command"] ?? ""), ...args];
    }

    return {
        recipes,
        assignments,
        aliases,
        settings,
        stringLists,
        modules: Object.keys(asRecord(root["modules"])).sort(),
        first: typeof root["first"] === "string" ? root["first"] : null,
    };
}

export function comparableFromParser(source: string, caps: DumpCapabilities): Comparable {
    const model = modelFromSource(source);

    const recipes = model.recipes
        .map((recipe): ComparableRecipe => {
            const attributes = recipe.attributes
                .map((a) => (a.args.length === 0 ? a.name : `${a.name}(${a.args.join(",")})`))
                .sort();
            return {
                name: recipe.name,
                parameters: recipe.parameters.map((p) => ({
                    name: p.name,
                    kind: p.kind,
                    export: p.export,
                    hasDefault: p.hasDefault,
                })),
                // The dump concatenates priors and subsequents into one list.
                dependencies: [...recipe.dependencies, ...recipe.subsequents].map((d) => ({
                    recipe: d.recipe,
                    argumentCount: d.argumentCount,
                })),
                priors: recipe.dependencies.length,
                attributes,
                doc: recipe.doc ?? null,
                quiet: recipe.quiet,
                shebang: recipe.shebang,
                private: recipe.private,
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

    const assignments = model.assignments
        .map(
            (a): ComparableAssignment => ({
                name: a.name,
                export: a.export,
                ...(caps.assignmentPrivate ? { private: a.private } : {}),
            }),
        )
        .sort((a, b) => a.name.localeCompare(b.name));

    const aliases = model.aliases
        .map((a) => ({ name: a.name, target: a.target }))
        .sort((a, b) => a.name.localeCompare(b.name));

    const stringLists: Record<string, readonly string[]> = {};
    for (const setting of model.settings) {
        const key = settingKey(setting.name);
        if (setting.list !== undefined && STRING_LIST_SETTINGS.some((s) => s === key)) {
            stringLists[key] = setting.list;
        }
    }

    return {
        recipes,
        assignments,
        aliases,
        settings: model.settings.map((s) => settingKey(s.name)).sort(),
        stringLists,
        modules: model.modules.map((m) => m.name).sort(),
        first: model.first ?? null,
    };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export interface Fixture {
    readonly name: string;
    readonly path: string;
    readonly source: string;
    /** From a `# requires: X.Y.Z` header, so old binaries skip rather than fail. */
    readonly requires?: string;
}

export function loadFixtures(): Fixture[] {
    return readdirSync(FIXTURES_DIR)
        .filter((name) => name.endsWith(".just"))
        .sort()
        .map((name) => {
            const path = join(FIXTURES_DIR, name);
            const source = readFileSync(path, "utf8");
            const requires = /^#\s*requires:\s*([0-9.]+)\s*$/m.exec(source)?.[1];
            const base = { name, path, source } as const;
            return requires === undefined ? base : { ...base, requires };
        });
}

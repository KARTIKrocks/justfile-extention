/**
 * Loading and introspecting the TextMate grammar.
 *
 * The grammar is data, not code, so nothing type-checks it and a typo in an
 * `include` silently turns highlighting off for whole constructs. These helpers
 * exist so tests can hold it to the same standard as the parser.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as oniguruma from "vscode-oniguruma";
import type { IGrammar } from "vscode-textmate";
import { INITIAL, parseRawGrammar, Registry } from "vscode-textmate";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

export const GRAMMAR_PATH = join(repoRoot, "syntaxes", "just.tmLanguage.json");

/** A TextMate rule, typed only as far as the tests actually inspect it. */
export interface Rule {
    readonly name?: string;
    readonly match?: string;
    readonly begin?: string;
    readonly end?: string;
    readonly while?: string;
    readonly include?: string;
    readonly patterns?: readonly Rule[];
    readonly captures?: Readonly<Record<string, Rule>>;
    readonly beginCaptures?: Readonly<Record<string, Rule>>;
    readonly endCaptures?: Readonly<Record<string, Rule>>;
}

export interface Grammar {
    readonly scopeName: string;
    readonly patterns: readonly Rule[];
    readonly repository: Readonly<Record<string, Rule>>;
}

export function loadGrammar(): Grammar {
    return JSON.parse(readFileSync(GRAMMAR_PATH, "utf8")) as Grammar;
}

/** Every rule in the grammar, including the ones nested inside captures. */
export function allRules(grammar: Grammar): Rule[] {
    const out: Rule[] = [];
    const visit = (rule: Rule): void => {
        out.push(rule);
        for (const child of rule.patterns ?? []) {
            visit(child);
        }
        for (const group of [rule.captures, rule.beginCaptures, rule.endCaptures]) {
            for (const child of Object.values(group ?? {})) {
                visit(child);
            }
        }
    };
    for (const rule of grammar.patterns) {
        visit(rule);
    }
    for (const rule of Object.values(grammar.repository)) {
        visit(rule);
    }
    return out;
}

/**
 * How many capturing groups a pattern has.
 *
 * Capture keys that point past the end are the classic TextMate bug: the scope
 * is simply never applied, and nothing anywhere reports it.
 */
export function countCaptureGroups(pattern: string): number {
    let count = 0;
    let inClass = false;
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === "\\") {
            i++;
            continue;
        }
        if (inClass) {
            if (c === "]") {
                inClass = false;
            }
            continue;
        }
        if (c === "[") {
            inClass = true;
            continue;
        }
        if (c === "(" && pattern[i + 1] !== "?") {
            count++;
        }
    }
    return count;
}

/** Pull an alternation of literal names back out of a rule's pattern. */
function namesFrom(pattern: string, prefix: string, suffix: string): string[] {
    const start = pattern.indexOf(prefix);
    if (start === -1) {
        throw new Error(`grammar pattern no longer starts its name list with ${prefix}`);
    }
    const from = start + prefix.length;
    const end = pattern.indexOf(suffix, from);
    if (end === -1) {
        throw new Error(`grammar pattern no longer ends its name list with ${suffix}`);
    }
    return pattern.slice(from, end).split("|");
}

/** The setting names the grammar highlights after `set`. */
export function settingNames(grammar: Grammar): string[] {
    const pattern = grammar.repository["setting"]?.begin;
    if (pattern === undefined) {
        throw new Error("the grammar has no `setting` rule with a begin pattern");
    }
    return namesFrom(pattern, "[ \\t]+(", ")(?!");
}

/** The attribute names the grammar highlights inside `[...]`. */
export function attributeNames(grammar: Grammar): string[] {
    const rule = grammar.repository["attribute"];
    const named = (rule?.patterns ?? []).find((p) => p.match?.includes("|") === true);
    if (named?.match === undefined) {
        throw new Error("the grammar has no attribute-name alternation");
    }
    return namesFrom(named.match, "(?<![A-Za-z0-9_-])(", ")(?![A-Za-z0-9_-])");
}

/**
 * Tokenising with the same engine VS Code uses.
 *
 * Structural checks prove the grammar is well formed; only running it proves it
 * highlights anything. vscode-textmate and vscode-oniguruma are the real
 * implementations, so what passes here is what the editor will do.
 */

const require_ = createRequire(import.meta.url);

let cached: Promise<IGrammar> | undefined;

function loadEngine(): Promise<IGrammar> {
    const wasm = readFileSync(require_.resolve("vscode-oniguruma/release/onig.wasm"));
    const onigLib = oniguruma
        .loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength))
        .then(() => ({
            createOnigScanner: (sources: string[]) => new oniguruma.OnigScanner(sources),
            createOnigString: (str: string) => new oniguruma.OnigString(str),
        }));

    const registry = new Registry({
        onigLib,
        loadGrammar: async (scopeName) =>
            scopeName === "source.just"
                ? parseRawGrammar(readFileSync(GRAMMAR_PATH, "utf8"), GRAMMAR_PATH)
                : null,
    });

    return registry.loadGrammar("source.just").then((loaded) => {
        if (loaded === null) {
            throw new Error("the registry would not load source.just");
        }
        return loaded;
    });
}

export function engine(): Promise<IGrammar> {
    cached ??= loadEngine();
    return cached;
}

export interface ScopedToken {
    readonly text: string;
    readonly line: number;
    readonly startIndex: number;
    readonly scopes: readonly string[];
}

/** Every token in the source, in order, with the scopes that apply to it. */
export async function tokenize(source: string): Promise<ScopedToken[]> {
    const grammar = await engine();
    const out: ScopedToken[] = [];
    let stack = INITIAL;
    // VS Code tokenises line content with the terminator already stripped, so a
    // CRLF file never shows the engine a `\r`. Splitting on `\n` alone would.
    const lines = source.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
    for (let line = 0; line < lines.length; line++) {
        const text = lines[line] ?? "";
        const result = grammar.tokenizeLine(text, stack);
        for (const token of result.tokens) {
            out.push({
                text: text.slice(token.startIndex, token.endIndex),
                line,
                startIndex: token.startIndex,
                scopes: token.scopes,
            });
        }
        stack = result.ruleStack;
    }
    return out;
}

/**
 * The scopes applied to the first occurrence of `needle`.
 *
 * Matching on the source text rather than a line and column keeps the tests
 * readable and lets them survive edits to the fixture around them.
 */
export async function scopesAt(source: string, needle: string): Promise<string[]> {
    const offset = source.indexOf(needle);
    if (offset === -1) {
        throw new Error(`${JSON.stringify(needle)} does not appear in the source`);
    }
    const before = source.slice(0, offset);
    const line = before.split("\n").length - 1;
    const column = offset - (before.lastIndexOf("\n") + 1);

    for (const token of await tokenize(source)) {
        if (
            token.line === line &&
            token.startIndex <= column &&
            column < token.startIndex + token.text.length
        ) {
            return [...token.scopes];
        }
    }
    throw new Error(`no token covers ${JSON.stringify(needle)}`);
}

/**
 * Structural tests for the TextMate grammar.
 *
 * A grammar fails silently: a bad `include`, a capture index past the end of
 * the pattern, or a `begin` with no `end` costs highlighting somewhere and
 * reports nothing. These checks are the only thing standing in for a compiler.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    allRules,
    attributeNames,
    countCaptureGroups,
    GRAMMAR_PATH,
    type Grammar,
    loadGrammar,
    type Rule,
    settingNames,
} from "./grammar.js";

const grammar: Grammar = loadGrammar();

describe("grammar structure", () => {
    it("declares the scope name the language contribution points at", () => {
        expect(grammar.scopeName).toBe("source.just");
    });

    it("resolves every include to a rule that exists", () => {
        const known = new Set(Object.keys(grammar.repository));
        const missing: string[] = [];
        for (const rule of allRules(grammar)) {
            const target = rule.include;
            if (target === undefined || target === "$self" || target === "$base") {
                continue;
            }
            if (!target.startsWith("#") || !known.has(target.slice(1))) {
                missing.push(target);
            }
        }
        expect(missing).toEqual([]);
    });

    it("uses every rule it defines", () => {
        const used = new Set<string>();
        for (const rule of allRules(grammar)) {
            if (rule.include?.startsWith("#") === true) {
                used.add(rule.include.slice(1));
            }
        }
        const orphans = Object.keys(grammar.repository).filter(
            (name) => !used.has(name) && !grammar.patterns.some((p) => p.include === `#${name}`),
        );
        expect(orphans).toEqual([]);
    });

    it("gives every begin rule a matching end", () => {
        const unterminated = allRules(grammar)
            .filter((r) => r.begin !== undefined && r.end === undefined && r.while === undefined)
            .map((r) => r.begin);
        expect(unterminated).toEqual([]);
    });

    it("never points a capture past the end of its pattern", () => {
        const overruns: string[] = [];
        const check = (pattern: string | undefined, captures: Rule["captures"]): void => {
            if (pattern === undefined || captures === undefined) {
                return;
            }
            const groups = countCaptureGroups(pattern);
            for (const key of Object.keys(captures)) {
                if (Number(key) > groups) {
                    overruns.push(`${pattern} has ${groups} groups but references ${key}`);
                }
            }
        };
        for (const rule of allRules(grammar)) {
            check(rule.match, rule.captures);
            check(rule.begin, rule.beginCaptures);
            check(rule.end, rule.endCaptures);
        }
        expect(overruns).toEqual([]);
    });

    it("compiles every pattern", () => {
        // An approximation: JS regex is not Oniguruma, so this catches unbalanced
        // groups and bad classes rather than proving VS Code will accept them.
        const broken: string[] = [];
        for (const rule of allRules(grammar)) {
            for (const pattern of [rule.match, rule.begin, rule.end, rule.while]) {
                if (pattern === undefined) {
                    continue;
                }
                try {
                    new RegExp(pattern);
                } catch (error) {
                    broken.push(`${pattern}: ${String(error)}`);
                }
            }
        }
        expect(broken).toEqual([]);
    });

    it("scopes every rule that is not purely structural", () => {
        // A rule with no name and no captures colours nothing, which is almost
        // always a rule someone forgot to finish.
        const silent = allRules(grammar).filter(
            (r) =>
                r.include === undefined &&
                r.name === undefined &&
                r.captures === undefined &&
                r.beginCaptures === undefined &&
                r.endCaptures === undefined &&
                r.patterns === undefined,
        );
        expect(silent).toEqual([]);
    });
});

describe("grammar registration", () => {
    const pkg = JSON.parse(
        readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
        contributes: { grammars?: { language: string; scopeName: string; path: string }[] };
    };

    it("is contributed for the just language", () => {
        const entry = pkg.contributes.grammars?.find((g) => g.language === "just");
        expect(entry).toBeDefined();
        expect(entry?.scopeName).toBe(grammar.scopeName);
    });

    it("points at a file that is on disk", () => {
        expect(existsSync(GRAMMAR_PATH)).toBe(true);
    });
});

describe("name lists", () => {
    it("extracts the settings the grammar knows", () => {
        const names = settingNames(grammar);
        expect(names.length).toBeGreaterThan(20);
        expect(names).toContain("shell");
        expect(names).toContain("script-interpreter");
    });

    it("extracts the attributes the grammar knows", () => {
        const names = attributeNames(grammar);
        expect(names.length).toBeGreaterThan(20);
        expect(names).toContain("group");
        expect(names).toContain("working-directory");
    });

    it("lists each name once", () => {
        for (const names of [settingNames(grammar), attributeNames(grammar)]) {
            expect(names.length).toBe(new Set(names).size);
        }
    });

    it("orders alternations so no name shadows a longer one that shares its prefix", () => {
        // Oniguruma takes the first alternative that matches, so `shell` placed
        // before `shell-expand` would leave the tail of the longer name unscoped.
        for (const names of [settingNames(grammar), attributeNames(grammar)]) {
            for (let i = 0; i < names.length; i++) {
                for (let j = i + 1; j < names.length; j++) {
                    const earlier = names[i] ?? "";
                    const later = names[j] ?? "";
                    expect(
                        later.startsWith(earlier),
                        `${earlier} precedes ${later} and shares its prefix`,
                    ).toBe(false);
                }
            }
        }
    });
});

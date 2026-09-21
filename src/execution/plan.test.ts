import { describe, expect, it } from "vitest";
import { modelFromSource } from "../model/build.js";
import type { ModelRecipe } from "../model/justfile.js";
import { commandLabel, isRequired, justArgv, needsArguments, promptsFor } from "./plan.js";

function recipeOf(source: string): ModelRecipe {
    const recipe = modelFromSource(source).recipes[0];
    if (recipe === undefined) {
        throw new Error(`no recipe in: ${source}`);
    }
    return recipe;
}

describe("isRequired", () => {
    it("is true for a bare parameter and a `+` variadic", () => {
        const [a, b] = recipeOf("r a +b:\n    echo\n").parameters;
        expect(a && isRequired(a)).toBe(true);
        expect(b && isRequired(b)).toBe(true);
    });

    it("is false for a default and a `*` variadic", () => {
        const [a, b] = recipeOf('r a="x" *b:\n    echo\n').parameters;
        expect(a && isRequired(a)).toBe(false);
        expect(b && isRequired(b)).toBe(false);
    });
});

describe("needsArguments", () => {
    it("is false for a recipe with no parameters", () => {
        expect(needsArguments(recipeOf("build:\n    echo\n"))).toBe(false);
    });

    it("is false when every parameter can be omitted", () => {
        expect(needsArguments(recipeOf('deploy env="staging" *extra:\n    echo\n'))).toBe(false);
    });

    it("is true as soon as one parameter has no default", () => {
        expect(needsArguments(recipeOf('deploy env version="latest":\n    echo\n'))).toBe(true);
    });

    it("is true for a `+` variadic, which needs at least one value", () => {
        expect(needsArguments(recipeOf("test +files:\n    echo\n"))).toBe(true);
    });
});

describe("promptsFor", () => {
    it("keeps parameter order and marks each one", () => {
        const prompts = promptsFor(recipeOf('r a b="x" *c:\n    echo\n'));
        expect(prompts.map((p) => [p.parameter.name, p.optional, p.repeatable])).toEqual([
            ["a", false, false],
            ["b", true, false],
            ["c", true, true],
        ]);
    });

    it("is empty for a recipe without parameters", () => {
        expect(promptsFor(recipeOf("r:\n    echo\n"))).toEqual([]);
    });
});

describe("justArgv", () => {
    it("names the justfile and working directory explicitly, then the recipe and its arguments", () => {
        expect(justArgv("/w/justfile", "/w", "deploy", ["staging", "1.2"])).toEqual([
            "--justfile",
            "/w/justfile",
            "--working-directory",
            "/w",
            "deploy",
            "staging",
            "1.2",
        ]);
    });

    it("inserts no separator: just stops option parsing at the recipe name", () => {
        // Verified against 1.21.0 and 1.58.0: `just e -x` and `just e --`
        // both hand the token to the recipe untouched. A `--` of our own
        // would reach the recipe as a literal argument.
        expect(justArgv("/w/justfile", "/w", "e", ["-x", "--verbose"])).toEqual([
            "--justfile",
            "/w/justfile",
            "--working-directory",
            "/w",
            "e",
            "-x",
            "--verbose",
        ]);
    });

    it("keeps every argument as its own element, never joining", () => {
        const argv = justArgv("/w/justfile", "/w", "e", ["two words", 'q"uote']);
        expect(argv.slice(-2)).toEqual(["two words", 'q"uote']);
    });
});

describe("commandLabel", () => {
    it("reads like the command line the user would type", () => {
        expect(commandLabel("build", [])).toBe("just build");
        expect(commandLabel("deploy", ["staging"])).toBe("just deploy staging");
    });
});

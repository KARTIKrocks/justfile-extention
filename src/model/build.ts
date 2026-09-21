/**
 * Builds the semantic model from a syntax tree.
 *
 * Tier 1: no VS Code API, no I/O, no subprocesses. See AGENTS.md.
 *
 * This step is structural only. It resolves nothing that would require running
 * a command or evaluating an expression, because just does both at parse time
 * and we deliberately do neither.
 */

import type {
    Attribute,
    Dependency,
    Expression,
    Justfile,
    Parameter,
    Recipe,
} from "../parser/ast.js";
import { parse } from "../parser/parser.js";
import type {
    JustfileModel,
    ModelAlias,
    ModelAssignment,
    ModelAttribute,
    ModelDependency,
    ModelImport,
    ModelModule,
    ModelParameter,
    ModelRecipe,
    ModelSetting,
} from "./justfile.js";

/**
 * A list of string literals, or undefined if it is anything else.
 *
 * Undefined covers three different situations on purpose — not a list, an
 * element that needs evaluating, an unterminated string with no value — because
 * the model draws one line and it is between "the file says this" and "working
 * that out means running something".
 */
function literalStrings(value: Expression | undefined): string[] | undefined {
    if (value?.kind !== "list") {
        return undefined;
    }
    const strings: string[] = [];
    for (const element of value.elements) {
        if (element.kind !== "string" || element.value === undefined) {
            return undefined;
        }
        strings.push(element.value);
    }
    return strings;
}

function buildAttribute(attribute: Attribute): ModelAttribute {
    return {
        name: attribute.name.text,
        args: attribute.args.map((a) => a.value),
        span: attribute.span,
    };
}

function buildParameter(parameter: Parameter): ModelParameter {
    return {
        name: parameter.name.text,
        kind: parameter.parameterKind,
        export: parameter.exported,
        hasDefault: parameter.default !== undefined,
        span: parameter.span,
    };
}

function buildDependency(dependency: Dependency): ModelDependency {
    return {
        recipe: dependency.name.text,
        argumentCount: dependency.args.length,
        span: dependency.span,
    };
}

function buildRecipe(recipe: Recipe): ModelRecipe {
    const attributes = recipe.attributes.map(buildAttribute);
    // just treats a leading underscore and the [private] attribute identically.
    const isPrivate =
        recipe.name.text.startsWith("_") || attributes.some((a) => a.name === "private");

    const base = {
        name: recipe.name.text,
        parameters: recipe.parameters.map(buildParameter),
        dependencies: recipe.dependencies.map(buildDependency),
        subsequents: recipe.subsequents.map(buildDependency),
        attributes,
        quiet: recipe.quiet,
        shebang: recipe.shebang,
        private: isPrivate,
        span: recipe.span,
        nameSpan: recipe.name.span,
    } as const;

    return recipe.doc === undefined ? base : { ...base, doc: recipe.doc };
}

export function buildModel(ast: Justfile): JustfileModel {
    const recipes: ModelRecipe[] = [];
    const assignments: ModelAssignment[] = [];
    const aliases: ModelAlias[] = [];
    const settings: ModelSetting[] = [];
    const imports: ModelImport[] = [];
    const modules: ModelModule[] = [];

    for (const item of ast.items) {
        switch (item.kind) {
            case "recipe":
                recipes.push(buildRecipe(item));
                break;
            case "assignment":
                assignments.push({
                    name: item.name.text,
                    export: item.exported,
                    private: item.name.text.startsWith("_"),
                    span: item.span,
                    nameSpan: item.name.span,
                });
                break;
            case "alias":
                if (item.target !== undefined) {
                    aliases.push({
                        name: item.name.text,
                        target: item.target.text,
                        span: item.span,
                        nameSpan: item.name.span,
                    });
                }
                break;
            case "setting": {
                const list = literalStrings(item.value);
                settings.push({
                    name: item.name.text,
                    ...(list !== undefined && { list }),
                    span: item.span,
                });
                break;
            }
            case "import":
                if (item.path?.value !== undefined) {
                    imports.push({
                        path: item.path.value,
                        optional: item.optional,
                        span: item.span,
                    });
                }
                break;
            case "module": {
                const path = item.path?.value;
                const base = {
                    name: item.name.text,
                    optional: item.optional,
                    span: item.span,
                    nameSpan: item.name.span,
                } as const;
                modules.push(path === undefined ? base : { ...base, path });
                break;
            }
            case "error-item":
                break;
        }
    }

    // `just` with no arguments runs the first recipe defined, private or not.
    const first = recipes[0]?.name;

    const model = {
        source: "parser",
        recipes,
        assignments,
        aliases,
        settings,
        imports,
        modules,
    } as const;

    return first === undefined ? model : { ...model, first };
}

export function modelFromSource(source: string): JustfileModel {
    return buildModel(parse(source));
}

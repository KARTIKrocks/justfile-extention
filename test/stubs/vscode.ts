/**
 * A stand-in for the `vscode` module, for testing the provider layer.
 *
 * The extension host is not available in a unit test, so without this the only
 * untested code in the extension would be the layer that actually talks to the
 * editor — registration, encoding, disposal — which is where a silent mistake
 * costs the most. Type checking still runs against the real `@types/vscode`;
 * this is substituted at run time only, by an alias in `vitest.config.mts`.
 *
 * It implements exactly what the extension calls and nothing else. Anything
 * missing should fail loudly rather than quietly returning undefined.
 */

export interface Disposable {
    dispose(): void;
}

type Listener<T> = (event: T) => void;

class EventSource<T> {
    readonly listeners: Listener<T>[] = [];

    readonly register = (listener: Listener<T>): Disposable => {
        this.listeners.push(listener);
        return { dispose: () => {} };
    };

    emit(event: T): void {
        for (const listener of this.listeners) {
            listener(event);
        }
    }
}

export class Position {
    readonly line: number;
    readonly character: number;

    constructor(line: number, character: number) {
        this.line = line;
        this.character = character;
    }
}

export class Range {
    readonly start: Position;
    readonly end: Position;

    constructor(start: Position, end: Position) {
        this.start = start;
        this.end = end;
    }
}

/** Only the members the extension maps onto; the numbers are VS Code's. */
export const SymbolKind = {
    File: 0,
    Module: 1,
    Namespace: 2,
    Property: 6,
    Function: 11,
    Variable: 12,
} as const;

export class DocumentSymbol {
    readonly name: string;
    readonly detail: string;
    readonly kind: number;
    readonly range: Range;
    readonly selectionRange: Range;
    children: DocumentSymbol[] = [];

    constructor(name: string, detail: string, kind: number, range: Range, selectionRange: Range) {
        this.name = name;
        this.detail = detail;
        this.kind = kind;
        this.range = range;
        this.selectionRange = selectionRange;
    }
}

/** Numbers match VS Code's; only `Comment` is ever mapped onto. */
export const FoldingRangeKind = {
    Comment: 1,
    Imports: 2,
    Region: 3,
} as const;

export class FoldingRange {
    readonly start: number;
    readonly end: number;
    readonly kind: number | undefined;

    constructor(start: number, end: number, kind?: number) {
        this.start = start;
        this.end = end;
        this.kind = kind;
    }
}

export class SemanticTokensLegend {
    // Written out rather than declared as parameter properties: those emit
    // runtime code, which `erasableSyntaxOnly` forbids. See AGENTS.md.
    readonly tokenTypes: string[];
    readonly tokenModifiers: string[];

    constructor(tokenTypes: string[], tokenModifiers: string[]) {
        this.tokenTypes = tokenTypes;
        this.tokenModifiers = tokenModifiers;
    }
}

export interface PushedToken {
    readonly line: number;
    readonly char: number;
    readonly length: number;
    readonly tokenType: number;
    readonly tokenModifiers: number;
}

export class SemanticTokens {
    readonly pushed: readonly PushedToken[];

    constructor(pushed: readonly PushedToken[]) {
        this.pushed = pushed;
    }
}

export class SemanticTokensBuilder {
    readonly pushed: PushedToken[] = [];

    readonly legend: SemanticTokensLegend | undefined;

    constructor(legend?: SemanticTokensLegend) {
        this.legend = legend;
    }

    push(line: number, char: number, length: number, tokenType: number, tokenModifiers = 0): void {
        this.pushed.push({ line, char, length, tokenType, tokenModifiers });
    }

    build(): SemanticTokens {
        return new SemanticTokens(this.pushed);
    }
}

export interface RegisteredProvider {
    readonly selector: unknown;
    readonly provider: { provideDocumentSemanticTokens(document: unknown): unknown };
    readonly legend: SemanticTokensLegend;
}

export interface RegisteredSymbolProvider {
    readonly selector: unknown;
    readonly provider: { provideDocumentSymbols(document: unknown): unknown };
}

export interface RegisteredFoldingRangeProvider {
    readonly selector: unknown;
    readonly provider: { provideFoldingRanges(document: unknown): unknown };
}

export const StatusBarAlignment = {
    Left: 1,
    Right: 2,
} as const;

export class StatusBarItem {
    text = "";
    tooltip: string | undefined;
    command: string | undefined;
    shown = false;
    disposed = false;

    show(): void {
        this.shown = true;
    }

    hide(): void {
        this.shown = false;
    }

    dispose(): void {
        this.disposed = true;
    }
}

export interface ConfigurationChangeEvent {
    affectsConfiguration(section: string): boolean;
}

/** Everything the stub recorded. Reset between tests with `resetStub()`. */
export const recorded = {
    semanticTokenProviders: [] as RegisteredProvider[],
    documentSymbolProviders: [] as RegisteredSymbolProvider[],
    foldingRangeProviders: [] as RegisteredFoldingRangeProvider[],
    outputChannels: [] as { name: string; messages: string[]; disposed: boolean }[],
    onDidCloseTextDocument: new EventSource<{ uri: { toString(): string } }>(),
    onDidGrantWorkspaceTrust: new EventSource<void>(),
    onDidChangeConfiguration: new EventSource<ConfigurationChangeEvent>(),
    statusBarItems: [] as StatusBarItem[],
    commands: new Map<string, (...args: unknown[]) => unknown>(),
    executedCommands: [] as { command: string; args: unknown[] }[],
    warningMessages: [] as string[],
    infoMessages: [] as string[],
    /** `"section.key"` → value, read back by `workspace.getConfiguration`. */
    config: new Map<string, unknown>(),
};

export function resetStub(): void {
    recorded.semanticTokenProviders.length = 0;
    recorded.documentSymbolProviders.length = 0;
    recorded.foldingRangeProviders.length = 0;
    recorded.outputChannels.length = 0;
    recorded.onDidCloseTextDocument.listeners.length = 0;
    recorded.onDidGrantWorkspaceTrust.listeners.length = 0;
    recorded.onDidChangeConfiguration.listeners.length = 0;
    recorded.statusBarItems.length = 0;
    recorded.commands.clear();
    recorded.executedCommands.length = 0;
    recorded.warningMessages.length = 0;
    recorded.infoMessages.length = 0;
    recorded.config.clear();
    workspace.isTrusted = true;
}

export const languages = {
    registerDocumentSemanticTokensProvider(
        selector: unknown,
        provider: RegisteredProvider["provider"],
        legend: SemanticTokensLegend,
    ): Disposable {
        recorded.semanticTokenProviders.push({ selector, provider, legend });
        return { dispose: () => {} };
    },

    registerDocumentSymbolProvider(
        selector: unknown,
        provider: RegisteredSymbolProvider["provider"],
    ): Disposable {
        recorded.documentSymbolProviders.push({ selector, provider });
        return { dispose: () => {} };
    },

    registerFoldingRangeProvider(
        selector: unknown,
        provider: RegisteredFoldingRangeProvider["provider"],
    ): Disposable {
        recorded.foldingRangeProviders.push({ selector, provider });
        return { dispose: () => {} };
    },
};

export const window = {
    createOutputChannel(name: string, _options?: unknown) {
        const channel = { name, messages: [] as string[], disposed: false };
        recorded.outputChannels.push(channel);
        return {
            ...channel,
            info: (message: string) => channel.messages.push(message),
            dispose: () => {
                channel.disposed = true;
            },
        };
    },

    createStatusBarItem(_alignment?: number, _priority?: number): StatusBarItem {
        const item = new StatusBarItem();
        recorded.statusBarItems.push(item);
        return item;
    },

    showWarningMessage(message: string, ..._items: string[]): Promise<string | undefined> {
        recorded.warningMessages.push(message);
        return Promise.resolve(undefined);
    },

    showInformationMessage(message: string, ..._items: string[]): Promise<string | undefined> {
        recorded.infoMessages.push(message);
        return Promise.resolve(undefined);
    },
};

export const commands = {
    registerCommand(id: string, callback: (...args: unknown[]) => unknown): Disposable {
        recorded.commands.set(id, callback);
        return { dispose: () => recorded.commands.delete(id) };
    },

    executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
        recorded.executedCommands.push({ command, args });
        return Promise.resolve(undefined);
    },
};

interface Configuration {
    get<T>(key: string): T | undefined;
    get<T>(key: string, fallback: T): T;
}

export const workspace = {
    isTrusted: true,
    onDidCloseTextDocument: recorded.onDidCloseTextDocument.register,
    onDidGrantWorkspaceTrust: recorded.onDidGrantWorkspaceTrust.register,
    onDidChangeConfiguration: recorded.onDidChangeConfiguration.register,

    getConfiguration(section: string): Configuration {
        return {
            get<T>(key: string, fallback?: T): T | undefined {
                const value = recorded.config.get(`${section}.${key}`);
                return value === undefined ? fallback : (value as T);
            },
        };
    },
};

export const l10n = {
    t(message: string, ...args: unknown[]): string {
        return message.replace(/\{(\d+)\}/g, (whole, index: string) => {
            const value = args[Number(index)];
            return value === undefined ? whole : String(value);
        });
    },
};

# Development commands for the Justfile VS Code extension.
# Run `just --list` to see everything.

set shell := ["bash", "-euo", "pipefail", "-c"]

_default:
    @just --list --unsorted

# Install dependencies from the lockfile
[group('setup')]
install:
    npm ci

# Bundle the extension into dist/
[group('build')]
build:
    npm run build

# Rebuild on change
[group('build')]
watch:
    npm run watch

# Production bundle, with the size budget enforced
[group('build')]
build-release:
    node esbuild.mjs --production

# Typecheck, lint and unit tests — the pre-commit gate
[group('test')]
check: typecheck lint test-unit

# Everything, including the differential suite
[group('test')]
test: check difftest

[group('test')]
typecheck:
    npm run typecheck

[group('test')]
lint:
    npm run lint

[group('test')]
test-unit:
    npm run test:unit

# Compare our parser against the just CLI. just is the oracle.
[group('test')]
difftest:
    npm run test:diff

# Remove build output
[group('build')]
clean:
    rm -rf dist out .vscode-test coverage

# Show which just binary is in use, and the old one kept for version-gating tests
[group('setup')]
just-versions:
    @echo "development: $(command -v just) — $(just --version)"
    @echo "old target:  /usr/bin/just — $(/usr/bin/just --version 2>/dev/null || echo 'not installed')"

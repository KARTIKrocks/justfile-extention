# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-releases use an odd minor version (`0.1.x`, `0.3.x`, …) and stable releases an even
one, following the Marketplace's pre-release convention.

## [Unreleased]

## [0.3.0] — 2026-09-21

Pre-release. Odd minor, as the channel rule above says; 0.2.x is reserved for the first
stable release.

### Added

* **Run recipes.** A `▶ Run` CodeLens above every recipe, plus **Run with Arguments…** when
  the recipe has parameters, and `Just: Run Recipe` / `Just: Run Recipe with Arguments` in
  the Command Palette with a recipe picker. Required parameters are asked for; variadic ones
  (`+`, `*`) one value at a time. The run is a VS Code task in the integrated terminal —
  arguments go through as an argv array, quoted by VS Code for whatever shell the terminal
  uses, never spliced into a command string — so **Rerun Last Task**, terminal reuse and
  cancellation all work. Nothing runs in an untrusted workspace: the lens says so and opens
  the trust dialog instead.
* `just.codeLens.enabled` to turn the lenses off.

### Fixed

* Doc comments now match `just` exactly: whitespace is trimmed at both ends, only one `#`
  is stripped (`## x` documents as `# x`), and a comment that is blank after trimming is no
  doc at all. Found on a real Justfile whose doc line was indented under a `#` list.

## [0.1.1] — 2026-09-21

### Changed

* New icon: the `just` wordmark.

## [0.1.0] — 2026-09-21

First pre-release. Everything here runs in-process, without `just` installed and in
untrusted workspaces — nothing in this release executes a Justfile.

### Added

* Language definition for `justfile`, `Justfile`, `.justfile` and `*.just`, with comment
  toggling, bracket matching and auto-closing pairs.
* TextMate grammar covering recipes, parameters, dependencies, attributes, settings,
  assignments, string forms, interpolation, built-in functions and shebang bodies.
* Semantic tokens on top of the grammar, from a hand-written, error-tolerant parser.
* Document outline: recipes grouped by their `[group]` attributes, plus aliases,
  variables, settings, modules and imports.
* Folding for recipe bodies, multi-line expressions and comment blocks.
* `just` detection with a status bar item showing the installed version, plus the
  **Just: Check Just Installation**, **Just: Show Just Version** and
  **Just: Configure Just Executable** commands. Detection waits for Workspace Trust and
  never runs at activation.
* `just.executablePath` setting, ignored in untrusted workspaces.

[Unreleased]: https://github.com/KARTIKrocks/justfile-extention/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/KARTIKrocks/justfile-extention/compare/v0.1.1...v0.3.0
[0.1.1]: https://github.com/KARTIKrocks/justfile-extention/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/KARTIKrocks/justfile-extention/releases/tag/v0.1.0

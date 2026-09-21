# Releasing

How a version of the extension reaches the Visual Studio Marketplace and Open VSX. The
mechanics live in `.github/workflows/release.yml`; this is the part a person has to do.

## Channels

| Channel | Version | Who sees it |
|---|---|---|
| Pre-release | odd minor: `0.1.x`, `0.3.x`, … | Users who chose *Install Pre-Release Version* |
| Stable | even minor: `0.2.x`, `1.0.x`, … | Everyone |

The channel is decided by the version number alone. The odd/even rule is the Marketplace's
own convention: pre-release and stable share one version line, so the two channels must never
claim the same number.

Every published version gets a tag `vX.Y.Z`, and pushing that tag is what publishes it. The
workflow refuses a tag that does not match `package.json`, refuses any ref that is not on
`main` — only merged code ships — and reruns the full CI gate, differential suite included,
before packaging.

Pre-releases ship the Phase 2 feature set while the MVP is built. The first stable release is
the MVP.

## One-time setup

Both publishing targets need a token, stored as a repository secret in the `release`
environment (**Settings → Environments → release**). Using an environment rather than plain
repository secrets means a required reviewer can be added later without touching the workflow.

### Visual Studio Marketplace

1. Sign in at <https://marketplace.visualstudio.com/manage> with a Microsoft account and
   create a publisher. Its ID must match `publisher` in `package.json`, which is `KartikRajput`
   — change the manifest if you pick something else.
2. In Azure DevOps (<https://dev.azure.com>, any organisation), create a Personal Access Token
   with **Organization: All accessible organizations** and the single scope
   **Marketplace → Manage**.
3. Save it as the secret `VSCE_PAT`.

PATs expire — a year at most. Publishing will start failing with a 401 when it does; make a
new one and replace the secret.

### Open VSX

1. Sign in at <https://open-vsx.org> with GitHub, then create a namespace named after the
   publisher ID (`KartikRajput`) under your profile. The namespace and the Marketplace publisher
   ID must match, because the manifest holds only one.
2. Generate an access token from your profile page.
3. Save it as the secret `OVSX_PAT`.

Open VSX also asks new publishers to sign its [publisher agreement](https://open-vsx.org/about)
once, in the profile page, before the first publish goes through.

## Cutting a release, either channel

1. On a branch, bump `version` in `package.json` — next odd minor for a pre-release, next even
   minor for stable — and move the changelog's *Unreleased* entries under a heading for it.
   Open a PR and merge it.
2. Run `just package pre-release` (or `just package`) locally and glance at the file list
   `vsce ls` prints. This is the same build the workflow makes.
3. Tag the commit on `main` that carries the version bump and push the tag:

   ```
   git tag -a v0.1.2 -m "v0.1.2" && git push origin v0.1.2
   ```

   The tag message becomes the GitHub release notes, so paste the changelog section into it.
4. The workflow checks the tag against `package.json`, rebuilds, publishes to both stores and
   creates a GitHub release (marked pre-release when the version is) with the `.vsix` attached.

To see the `.vsix` a branch would produce without publishing anything, run
**Actions → Release → Run workflow** on that branch with *dry run* ticked. Dry run is the one
mode that accepts a ref that is not on `main`.

## If a publish fails halfway

Fix the cause and re-run the workflow. Both publish steps pass `--skip-duplicate`, so a store
that already has the version is skipped rather than failed, and only the missing one is
retried.

A version that has been published cannot be unpublished and re-used. Fix forward with a patch
release.

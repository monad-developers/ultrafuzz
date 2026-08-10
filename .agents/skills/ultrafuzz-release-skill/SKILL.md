---
name: ultrafuzz-release-skill
description: Publish Ultrafuzz GitHub releases from main and verify the published result. Use when asked to prepare release notes, identify merged pull requests since the previous release, publish the next v0.0.x release, or audit an Ultrafuzz release.
---

# Ultrafuzz Release

## Core Rule

Publish a non-draft, non-prerelease GitHub release from `main`. Inspect the
existing releases first and match their tag and title conventions. Use the
release-note structure defined below even when older releases use a flat list.
Publish only after the user explicitly asks to publish.

## Workflow

1. Verify the repository and target.
   - Confirm the remote is the intended Ultrafuzz repository and GitHub CLI is
     authenticated.
   - Fetch `origin/main` and tags. Do not release from a stale local branch.
   - Identify the latest published release and its tagged commit.
   - Use the version requested by the user, or propose the next patch version.
     Confirm that its tag and release do not already exist.

2. Build the complete change set.
   - List commits on `origin/main` after the previous release tag.
   - Resolve every merged pull request in that range and inspect its title,
     body, and changed files when needed to understand its feature category.
   - Include each user-facing pull request exactly once. Call out any commit
     that cannot be mapped confidently instead of silently omitting it.

3. Write release notes in the Ultrafuzz editorial format.
   - Open with one short paragraph explaining the release's main theme and
     user-visible value.
   - Follow it with 2-3 highlight bullets. Give each highlight a short bold
     lead-in and explain the outcome in human-readable language. Highlights may
     summarize the detailed entries and do not need PR numbers.
   - Add detailed sections named `## New features`, `## Improvements`, and
     `## Bug fixes`. Omit empty sections. Add `## Breaking changes` before
     `## New features` only when the release contains breaking changes.
   - Prefix each detailed bullet with one or two bold scope tags. Derive package
     tags from the affected `packages/<name>/` directories, using the package
     directory name, such as `**[runtime]**` or `**[config] [topology]**`.
     For changes outside `packages/`, derive equivalent stable tags from the
     affected repository surface, such as `**[docs]**`, `**[benchmarks]**`, or
     `**[workflows]**`. Choose the primary user-visible scopes rather than
     tagging every incidental test, fixture, or plumbing change.
   - Use one detailed bullet per pull request by default. Group multiple pull
     requests only when they contribute to one reader-understandable capability
     or fix and belong in the same section. Do not group changes merely because
     they touch the same package. Keep all grouped PR numbers together, such as
     `(#70, #71, #72)`.
   - Prefer present-tense wording such as `Adds`, `Improves`, or `Fixes`, and
     thank every PR author represented by the bullet before ending with its PR
     number or grouped PR numbers, such as `Thanks @alice! (#70)` or
     `Thanks @alice and @bob! (#70, #71)`. Deduplicate authors when aggregating
     multiple PRs. Include every user-facing pull request exactly once across
     the detailed sections.
   - End with a `**Full changelog**` link comparing the previous and current
     tags. Compare the draft against recent releases for tone and completeness,
     not to preserve their older flat-list structure.

4. Verify release readiness.
   - Resolve `origin/main` to the exact target commit and confirm the intended
     pull requests are merged into it.
   - Require all remote CI checks for that exact commit to complete
     successfully before publishing. Use `gh run list --commit "$TARGET_SHA"`
     and inspect any incomplete or failed run; do not treat missing results as
     success.
   - Run `pnpm install --frozen-lockfile` and `pnpm -w run ci` locally when
     release readiness also needs local verification.
   - Show the user the version, target commit, and exact notes before publishing
     unless the user already approved those exact values.

5. Publish the release.
   - Use the version for both tag and title.
   - Target the verified `main` commit.
   - Publish immediately; do not pass draft or prerelease flags.
   - Supply the reviewed notes from a file so Markdown and newlines are
     preserved exactly.

6. Verify publication.
   - Read the release back from GitHub and confirm `isDraft` and `isPrerelease`
     are both false, `targetCommitish` identifies the intended target, and the
     body matches the reviewed notes.
   - Fetch the published tag, peel it to its commit, and require that commit SHA
     to equal the exact target SHA resolved in step 4.
   - Report the release URL and any discrepancy.

## Safety Checks

- Never publish, edit, delete, or retarget a release without explicit user
  authorization.
- Never omit a pull request merely because it is hard to categorize.
- Never create the release from an unverified local `main` or feature branch.
- Never use automatically generated notes without reviewing and converting
  them to the Ultrafuzz editorial format above.

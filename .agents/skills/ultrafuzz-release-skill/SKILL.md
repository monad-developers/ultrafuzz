---
name: ultrafuzz-release-skill
description: Publish Ultrafuzz GitHub releases from main and verify the published result. Use when asked to prepare release notes, identify merged pull requests since the previous release, publish the next v0.0.x release, or audit an Ultrafuzz release.
---

# Ultrafuzz Release

## Core Rule

Publish a non-draft, non-prerelease GitHub release from `main`. Inspect the
existing releases first and match their tag, title, and release-note format.
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

3. Write release notes in the established format.
   - Use an unordered Markdown list with `-` markers and no introduction or
     section headings.
   - Keep every bullet to one physical line and write it as a concise sentence.
   - Use one bullet per pull request by default.
   - Group multiple pull requests into one bullet only when they are part of
     the same feature category. Keep all grouped PR numbers on that same line,
     such as `(#70, #71, #72)`.
   - Prefer present-tense wording such as `Adds`, `Improves`, or `Fixes`, and
     end each bullet with its PR number or grouped PR numbers.
   - Compare the draft against recent releases and ensure every included PR is
     represented once.

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
  them to the repository's established one-line unordered-list format.

# Licensing

Ultrafuzz is released under the MIT License. The canonical text is [`LICENSE`](../LICENSE) at the repository root, and
the SPDX identifier for the whole repository is `MIT`.

## Copyright attribution evidence

The notice reads `Copyright (c) 2026 Monad Developers`.

- **Holder.** `Monad Developers` is the display name of the GitHub organization that owns this repository
  (`github.com/monad-developers`). No prior copyright notice, header, or attribution existed anywhere in the tree, so the
  repository owner is the only evidence-backed holder. The organization's other first-party repositories carry no
  in-house notice to copy; its MIT-licensed repositories are forks that retain their upstream holders' notices.
- **Year.** A single year, not a range. Every commit in this repository is dated 2026 — the first commit
  (`56ef2c304698618c3c8214d5c9f0ac7f6bada3b9`) landed 2026-06-24, and no commit predates it. A range such as
  `2025-2026` would assert authorship in a year with no authorship.

If the intended holder is a different legal entity, changing the holder string in `LICENSE` is the only edit required —
no other file names a holder.

## SPDX and metadata consistency

| Surface                         | Declaration                                   |
| ------------------------------- | --------------------------------------------- |
| `LICENSE`                       | Full MIT text with the copyright notice above |
| Root `package.json`             | `"license": "MIT"`                            |
| Every `packages/*/package.json` | `"license": "MIT"`                            |
| `README.md`                     | License section naming MIT and `LICENSE`      |

`"license": "MIT"` is itself the SPDX short identifier that npm and pnpm expect, so the manifests and `LICENSE` express
one license with no second, divergent declaration to keep in sync. Per-file `SPDX-License-Identifier` headers are
deliberately not used: they would add a header to every source file without changing the licensing outcome, and the
repository-level declarations already cover every published surface.

## Why there is no NOTICE file

A NOTICE file would be misleading here rather than merely redundant, because nothing generates a notice obligation:

- **MIT has no notice-file mechanism.** Its only condition is that the copyright notice and permission notice travel
  with copies or substantial portions of the Software. `LICENSE` satisfies that. The attribution-notice file convention
  comes from Apache-2.0 §4(d), and no part of this repository is Apache-2.0 licensed.
- **No third-party source is vendored.** There is no `vendor/`, `third_party/`, or copied-upstream directory, and no
  source file in `packages/**` or `scripts/**` is derived from an external project.
- **Dependencies are not redistributed.** They resolve from their registries at install time and arrive with their own
  license texts under `node_modules`. This repository ships `pnpm-lock.yaml`, which records versions and integrity
  hashes, not licensed code.
- **The one third-party artifact carries no notice obligation.** `patches/npm@11.19.0.patch` is a pnpm patch applied to
  `node_modules` at install time. Its diff context includes fragments of npm's bundled `brace-expansion` (MIT),
  `ip-address` (MIT), `tar` (ISC), and `undici` (MIT). Both MIT and ISC require only that notices accompany copies, and
  the patched files remain inside their own upstream distributions, which ship their own `LICENSE` files alongside them.
  Neither license defines a NOTICE file to populate.

Add a NOTICE file if a later change vendors third-party source into the tree, or introduces an Apache-2.0 component
whose upstream ships its own NOTICE.

## Enforcement

`scripts/ci/license-metadata.test.ts` fails the `ci-scripts` release gate if `LICENSE` stops being the MIT text, if its
copyright line changes shape, or if any workspace package listed in `pnpm-workspace.yaml` stops declaring
`"license": "MIT"`.

# GitHub Pages Deployment

The docs site is built with MkDocs Material from the repository `docs/` root.

## Local Build

```bash
python -m pip install -r requirements-docs.txt
python -m mkdocs build --strict
```

Generated output goes to `site/`. That directory is ignored and must not be
committed.

## Pull Requests

`.github/workflows/docs.yml` builds the docs site on pull requests that touch
docs, MkDocs config, docs dependencies, or the docs workflow.

Pull requests validate the site but do not publish.

## Main Branch Deployment

On pushes to `main`, the same workflow builds the site, uploads the generated
`site/` directory as a GitHub Pages artifact, and deploys it with the standard
GitHub Pages Actions flow:

```text
actions/configure-pages
actions/upload-pages-artifact
actions/deploy-pages
```

Before deployment, the workflow reads the repository Pages settings and exits
unless GitHub reports the Pages site as private. This prevents accidental public
publication from a private repository when the organization plan or Pages
settings do not support private Pages.

The intended repository Pages URL is:

```text
https://monad-exp.github.io/ultrafuzz/
```

If GitHub assigns a private Pages URL under a unique `*.pages.github.io`
subdomain, use the URL shown by the deployment output or repository Settings ->
Pages.

## Private Pages Requirements

Private Pages for an organization repository requires GitHub Enterprise Cloud
and organization/repository settings that allow private Pages publication.

If publication is blocked, an organization or repository admin must:

1. Ensure the organization is on GitHub Enterprise Cloud.
2. Open the `monad-exp` organization settings.
3. Go to Member privileges.
4. Under Pages creation, allow privately published sites.
5. Open the `monad-exp/ultrafuzz` repository settings.
6. Go to Pages.
7. Select GitHub Actions as the source.
8. Set the Pages site visibility to private.
9. Re-run the docs deployment workflow on `main`.

An authorized repository or organization member should confirm they can open the
published site while unauthenticated access remains denied.

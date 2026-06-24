# Development Commands

Use workspace-local Cargo cache directories for repeatable checks.

## Rust

Focused iteration:

```bash
CARGO_HOME=.cargo-home CARGO_TARGET_DIR=.cargo-target cargo check -p <crate>
CARGO_HOME=.cargo-home CARGO_TARGET_DIR=.cargo-target cargo test -p <crate> <test-name>
```

PR validation:

```bash
cargo fmt --all -- --check
CARGO_HOME=.cargo-home CARGO_TARGET_DIR=.cargo-target cargo check --workspace
CARGO_HOME=.cargo-home CARGO_TARGET_DIR=.cargo-target cargo clippy --workspace --all-targets -- -D warnings
CARGO_HOME=.cargo-home CARGO_TARGET_DIR=.cargo-target cargo test --workspace
```

`make validate` runs rustfmt, workspace check, and Clippy. `make test` runs the
workspace test suite.

## Dashboard Frontend

```bash
npm --prefix crates/ultrafuzz-dashboard/frontend ci
npm --prefix crates/ultrafuzz-dashboard/frontend run format:check
npm --prefix crates/ultrafuzz-dashboard/frontend run lint
npm --prefix crates/ultrafuzz-dashboard/frontend run test
npm --prefix crates/ultrafuzz-dashboard/frontend run typecheck
npm --prefix crates/ultrafuzz-dashboard/frontend run build
```

Browser and embedded-asset smoke:

```bash
ULTRAFUZZ_DASHBOARD_REQUIRE_ASSETS=1 CARGO_HOME=.cargo-home CARGO_TARGET_DIR=.cargo-target cargo test -p ultrafuzz-dashboard
CARGO_HOME=.cargo-home CARGO_TARGET_DIR=.cargo-target npm --prefix crates/ultrafuzz-dashboard/frontend run smoke
make dashboard-smoke
```

Generated frontend assets are ignored:

```text
crates/ultrafuzz-dashboard/frontend/dist/
crates/ultrafuzz-dashboard/frontend/playwright-report/
crates/ultrafuzz-dashboard/frontend/test-results/
node_modules/
```

## Docs

```bash
python -m pip install -r requirements-docs.txt
python -m mkdocs build --strict
```

Generated docs output goes to `site/` and is ignored.

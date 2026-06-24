CARGO_HOME ?= .cargo-home
CARGO_TARGET_DIR ?= .cargo-target
CARGO_ENV := CARGO_HOME=$(CARGO_HOME) CARGO_TARGET_DIR=$(CARGO_TARGET_DIR)

.PHONY: all fmt check clippy validate test conformance dashboard-frontend-format-check dashboard-frontend-lint dashboard-frontend-test dashboard-frontend-typecheck dashboard-frontend dashboard-smoke clean

all: validate test

fmt:
	cargo fmt --all -- --check

check:
	$(CARGO_ENV) cargo check --workspace

clippy:
	$(CARGO_ENV) cargo clippy --workspace --all-targets -- -D warnings

validate: fmt check clippy

test:
	$(CARGO_ENV) cargo test --workspace

conformance: test

dashboard-frontend-format-check:
	npm --prefix crates/ultrafuzz-dashboard/frontend run format:check

dashboard-frontend-lint:
	npm --prefix crates/ultrafuzz-dashboard/frontend run lint

dashboard-frontend-test:
	npm --prefix crates/ultrafuzz-dashboard/frontend run test

dashboard-frontend-typecheck:
	npm --prefix crates/ultrafuzz-dashboard/frontend run typecheck

dashboard-frontend:
	npm --prefix crates/ultrafuzz-dashboard/frontend run build

dashboard-smoke: dashboard-frontend
	npm --prefix crates/ultrafuzz-dashboard/frontend exec -- playwright install --with-deps chromium
	npm --prefix crates/ultrafuzz-dashboard/frontend run smoke

clean:
	rm -rf $(CARGO_TARGET_DIR)

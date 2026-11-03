# Ultrafuzz builds this image with Modal; no registry or Docker daemon is
# required on the host. Runtime inputs and model credentials are separate.
FROM node:22.23.4-bookworm-slim

ARG OPENCODE_VERSION=1.19.3
ARG CLAUDE_CODE_VERSION=2.1.306
ARG CODEX_VERSION=0.163.0
ARG BUN_VERSION=1.4.4
ARG FOUNDRY_VERSION=1.8.5
ARG FOUNDRY_SHA256=6c66ffcc55fa4249197721baa3098bc208014ea1d8aa04b2ed50ac6bccffb226
ARG MEDUSA_VERSION=1.5.1
ARG MEDUSA_SHA256=ddfe1517ae9028ef9fc331b00f5a6a9d5406f3fcd11a715d60c6b6fb3e4546d3
ARG ECHIDNA_VERSION=2.3.3
ARG ECHIDNA_SHA256=436d26cb5af34c6c525812b857ac53f218c7f6ad07d69495ef88bc4cdc85c764
ARG TRAVERSE_VERSION=0.1.4
ARG TRAVERSE_SHA256=2320b9b896cc1ecd85d77e4802456cf96cf00df0accff5f5f31b6e6659f896cb
ARG SLITHER_VERSION=0.11.6
ARG SOLC_SELECT_VERSION=1.2.0
ARG SCRIBBLE_VERSION=0.7.10
ARG ROUNDME_VERSION=0.1.0
ARG RUSTUP_VERSION=1.28.2
ARG RUSTUP_SHA256=20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c
ARG RUST_TOOLCHAIN=1.85.0

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl git git-lfs jq libssl3 libudev1 procps \
    python3 python-is-python3 python3-venv ripgrep unzip zstd \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin ultrafuzz

RUN npm install --global "bun@${BUN_VERSION}" "opencode-ai@${OPENCODE_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force \
    && test "$(opencode --version)" = "${OPENCODE_VERSION}" \
    && test "$(claude --version)" = "${CLAUDE_CODE_VERSION} (Claude Code)" \
    && test "$(codex --version)" = "codex-cli ${CODEX_VERSION}" \
    && test "$(bun --version)" = "${BUN_VERSION}"

# Modal sandboxes use linux/amd64. Verify the pinned upstream release archive
# before installing its binaries (no mutable foundryup installer).
RUN test "$(dpkg --print-architecture)" = amd64 \
    && curl --fail --location --retry 3 \
       "https://github.com/foundry-rs/foundry/releases/download/v${FOUNDRY_VERSION}/foundry_v${FOUNDRY_VERSION}_linux_amd64.tar.gz" \
       --output /tmp/foundry.tar.gz \
    && echo "${FOUNDRY_SHA256}  /tmp/foundry.tar.gz" | sha256sum --check - \
    && tar -xzf /tmp/foundry.tar.gz -C /usr/local/bin forge cast anvil chisel \
    && rm /tmp/foundry.tar.gz \
    && forge --version

# Optional security tools that reviewers may use; a run's prompt decides whether
# to use them. Release archives are verified like Foundry. roundme has no binary
# release, so it is built with a temporary pinned Rust toolchain that is removed.
RUN curl --fail --location --retry 3 \
       "https://github.com/crytic/medusa/releases/download/v${MEDUSA_VERSION}/medusa-linux-x64.tar.gz" \
       --output /tmp/medusa.tar.gz \
    && echo "${MEDUSA_SHA256}  /tmp/medusa.tar.gz" | sha256sum --check - \
    && tar -xzf /tmp/medusa.tar.gz -C /usr/local/bin medusa \
    && curl --fail --location --retry 3 \
       "https://github.com/crytic/echidna/releases/download/v${ECHIDNA_VERSION}/echidna-${ECHIDNA_VERSION}-x86_64-linux.tar.gz" \
       --output /tmp/echidna.tar.gz \
    && echo "${ECHIDNA_SHA256}  /tmp/echidna.tar.gz" | sha256sum --check - \
    && tar -xzf /tmp/echidna.tar.gz -C /usr/local/bin echidna \
    && curl --fail --location --retry 3 \
       "https://github.com/calltrace/traverse/releases/download/v${TRAVERSE_VERSION}/traverse-linux-amd64.tar.gz" \
       --output /tmp/traverse.tar.gz \
    && echo "${TRAVERSE_SHA256}  /tmp/traverse.tar.gz" | sha256sum --check - \
    && tar -xzf /tmp/traverse.tar.gz -C /usr/local/bin sol2cg sol2test sol2bnd sol-storage-analyzer storage-trace \
    && rm /tmp/medusa.tar.gz /tmp/echidna.tar.gz /tmp/traverse.tar.gz \
    && medusa --version && echidna --version && test -x /usr/local/bin/sol2cg

RUN python3 -m venv /opt/sectools \
    && /opt/sectools/bin/pip install --no-cache-dir "slither-analyzer==${SLITHER_VERSION}" "solc-select==${SOLC_SELECT_VERSION}" \
    && ln -s /opt/sectools/bin/slither /opt/sectools/bin/crytic-compile /opt/sectools/bin/solc-select /usr/local/bin/ \
    && npm install --global "eth-scribble@${SCRIBBLE_VERSION}" && npm cache clean --force \
    && slither --version && scribble --version

RUN curl --fail --location --retry 3 \
       "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init" \
       --output /tmp/rustup-init \
    && echo "${RUSTUP_SHA256}  /tmp/rustup-init" | sha256sum --check - \
    && chmod +x /tmp/rustup-init \
    && CARGO_HOME=/tmp/cargo RUSTUP_HOME=/tmp/rustup /tmp/rustup-init -y -q --no-modify-path --profile minimal --default-toolchain "${RUST_TOOLCHAIN}" \
    && CARGO_HOME=/tmp/cargo RUSTUP_HOME=/tmp/rustup /tmp/cargo/bin/cargo install roundme --version "${ROUNDME_VERSION}" --locked --root /usr/local \
    && rm -rf /tmp/rustup-init /tmp/cargo /tmp/rustup \
    && test -x /usr/local/bin/roundme

ARG RECON_VERSION=0.4.17
# GitHub release asset digest, verified against Recon-Fuzz/recon-fuzzer v0.4.17.
ARG RECON_SHA256=8b7c8bee2ff9da88ce5eada7f021b8c933f2c6c0d6c597e2171cef84cd9884de
ARG RECON_GENERATE_VERSION=0.0.42
RUN curl --fail --location --retry 3 \
       "https://github.com/Recon-Fuzz/recon-fuzzer/releases/download/v${RECON_VERSION}/recon-linux-x86_64.tar.gz" \
       --output /tmp/recon.tar.gz \
    && echo "${RECON_SHA256}  /tmp/recon.tar.gz" | sha256sum --check - \
    && tar -xzf /tmp/recon.tar.gz -C /usr/local/bin \
    && rm /tmp/recon.tar.gz \
    && npm install --global "recon-generate@${RECON_GENERATE_VERSION}" \
    && npm cache clean --force \
    && /opt/sectools/bin/pip install --no-cache-dir \
       "covg-eval @ git+https://github.com/Recon-Fuzz/recon-magic-framework.git@f92ad26ff857526d221c3e8488c5aea2a20e8fdf#subdirectory=tools/covg_eval"

ENV OPENCODE_DISABLE_AUTOUPDATE=true
COPY dist/worker.js /opt/ultrafuzz/worker.js
COPY plugins/ /opt/ultrafuzz/plugins/
WORKDIR /run-data
CMD ["bun", "/opt/ultrafuzz/worker.js", "--root", "/run-data"]

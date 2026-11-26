# The worker image. The Docker executor builds this file with docker build.
# The Modal executor builds the same instructions on Modal, without a Docker
# daemon on the host. Runtime inputs and model credentials are separate.
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

# python3-dev has the headers to build Python packages that have no wheel.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl git git-lfs jq libssl3 libudev1 procps \
    python3 python-is-python3 python3-dev python3-venv ripgrep unzip zstd \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin ultrafuzz

RUN npm install --global "bun@${BUN_VERSION}" "opencode-ai@${OPENCODE_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force \
    && test "$(opencode --version)" = "${OPENCODE_VERSION}" \
    && test "$(claude --version)" = "${CLAUDE_CODE_VERSION} (Claude Code)" \
    && test "$(codex --version)" = "codex-cli ${CODEX_VERSION}" \
    && test "$(bun --version)" = "${BUN_VERSION}"

# The pinned tools are linux/amd64 builds. Verify the pinned upstream release
# archive before installing its binaries (no mutable foundryup installer).
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

# "solc" is the command of solc-select: it runs the compiler version that "solc-select use" selected.
RUN python3 -m venv /opt/sectools \
    && /opt/sectools/bin/pip install --no-cache-dir "slither-analyzer==${SLITHER_VERSION}" "solc-select==${SOLC_SELECT_VERSION}" \
    && ln -s /opt/sectools/bin/slither /opt/sectools/bin/crytic-compile /opt/sectools/bin/solc-select /opt/sectools/bin/solc /usr/local/bin/ \
    && npm install --global "eth-scribble@${SCRIBBLE_VERSION}" && npm cache clean --force \
    && slither --version && scribble --version && test -x /usr/local/bin/solc

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
       "covg-eval @ git+https://github.com/Recon-Fuzz/recon-magic-framework.git@f92ad26ff857526d221c3e8488c5aea2a20e8fdf#subdirectory=tools/covg_eval" \
    && ln -s /opt/sectools/bin/covg-eval /usr/local/bin/covg-eval \
    && covg-eval --help >/dev/null

# Vyper compilers, as the official release binaries. "vyper" is 0.3.9: Slither
# and crytic-compile in this image read the output of Vyper 0.3 only. The second
# version is the latest stable release. Each installed version is at
# /opt/vyper/<version>/vyper and on PATH as vyper-<version>. To use the other
# version as "vyper" for one command, put its directory first:
# PATH="/opt/vyper/0.4.3:$PATH" forge build
ARG VYPER_VERSION=0.3.9
ARG VYPER_COMMIT=66b96705
ARG VYPER_SHA256=72470456d4e387950e58a3f5af97482c76cfe8753e5f7df63a50b3a9712e4fc8
ARG VYPER_SECOND_VERSION=0.4.3
ARG VYPER_SECOND_COMMIT=bff19ea2
ARG VYPER_SECOND_SHA256=c986ec370f18d20ee8f8607b25c504c2795d73211662a05c3a1114a6320db0db
RUN mkdir -p "/opt/vyper/${VYPER_VERSION}" "/opt/vyper/${VYPER_SECOND_VERSION}" \
    && curl --fail --location --retry 3 \
       "https://github.com/vyperlang/vyper/releases/download/v${VYPER_VERSION}/vyper.${VYPER_VERSION}%2Bcommit.${VYPER_COMMIT}.linux" \
       --output "/opt/vyper/${VYPER_VERSION}/vyper" \
    && echo "${VYPER_SHA256}  /opt/vyper/${VYPER_VERSION}/vyper" | sha256sum --check - \
    && curl --fail --location --retry 3 \
       "https://github.com/vyperlang/vyper/releases/download/v${VYPER_SECOND_VERSION}/vyper.${VYPER_SECOND_VERSION}%2Bcommit.${VYPER_SECOND_COMMIT}.linux" \
       --output "/opt/vyper/${VYPER_SECOND_VERSION}/vyper" \
    && echo "${VYPER_SECOND_SHA256}  /opt/vyper/${VYPER_SECOND_VERSION}/vyper" | sha256sum --check - \
    && chmod 0755 "/opt/vyper/${VYPER_VERSION}/vyper" "/opt/vyper/${VYPER_SECOND_VERSION}/vyper" \
    && ln -s "/opt/vyper/${VYPER_VERSION}/vyper" /usr/local/bin/vyper \
    && ln -s "/opt/vyper/${VYPER_VERSION}/vyper" "/usr/local/bin/vyper-${VYPER_VERSION}" \
    && ln -s "/opt/vyper/${VYPER_SECOND_VERSION}/vyper" "/usr/local/bin/vyper-${VYPER_SECOND_VERSION}" \
    && echo "x: public(uint256)" > /tmp/x.vy \
    && vyper /tmp/x.vy >/dev/null && "vyper-${VYPER_SECOND_VERSION}" /tmp/x.vy >/dev/null \
    && rm /tmp/x.vy \
    && test "$(vyper --version)" = "${VYPER_VERSION}+commit.${VYPER_COMMIT}" \
    && test "$("vyper-${VYPER_SECOND_VERSION}" --version)" = "${VYPER_SECOND_VERSION}+commit.${VYPER_SECOND_COMMIT}"

# uv makes a Python environment for the project under review (uv venv, uv pip
# install) and can download other Python versions. Test frameworks such as
# titanoboa are not preinstalled: they must match the compiler of the project.
ARG UV_VERSION=0.13.8
ARG UV_SHA256=5acfd9177cfecf0bf87578f059728215ccc884388988f55f7a65041b57387d91
RUN curl --fail --location --retry 3 \
       "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz" \
       --output /tmp/uv.tar.gz \
    && echo "${UV_SHA256}  /tmp/uv.tar.gz" | sha256sum --check - \
    && tar -xzf /tmp/uv.tar.gz -C /usr/local/bin --strip-components=1 --no-same-owner \
       uv-x86_64-unknown-linux-gnu/uv uv-x86_64-unknown-linux-gnu/uvx \
    && rm /tmp/uv.tar.gz \
    && test "$(uv --version | cut -d' ' -f2)" = "${UV_VERSION}" \
    && test "$(uvx --version | cut -d' ' -f2)" = "${UV_VERSION}"

ENV OPENCODE_DISABLE_AUTOUPDATE=true
COPY dist/worker.js /opt/ultrafuzz/worker.js
COPY plugins/ /opt/ultrafuzz/plugins/
WORKDIR /run-data
CMD ["bun", "/opt/ultrafuzz/worker.js", "--root", "/run-data"]

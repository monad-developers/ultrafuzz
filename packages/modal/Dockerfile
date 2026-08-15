FROM ubuntu:24.04@sha256:561618e2c15bf2397621dd04f96926663a3b5616c189cf7e38db7e82f5c538ea AS toolchain

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH=/usr/local/bin:/opt/security-venv/bin:/home/ubuntu/.local/bin:$PATH
ENV DISABLE_AUTOUPDATER=1

COPY packages/modal/toolchain-materials.json /usr/share/ultrafuzz/toolchain-materials.json
COPY packages/modal/toolchain-materials.sha256 /usr/share/ultrafuzz/toolchain-materials.sha256
COPY pnpm-lock.yaml /usr/share/ultrafuzz/material-inputs/pnpm-lock.yaml
COPY pnpm-workspace.yaml /usr/share/ultrafuzz/material-inputs/pnpm-workspace.yaml
COPY package.json /usr/share/ultrafuzz/material-inputs/package.json
COPY packages/modal/package.json /usr/share/ultrafuzz/material-inputs/modal-package.json
COPY packages/modal/security-requirements.lock /usr/share/ultrafuzz/material-inputs/security-requirements.lock
COPY packages/modal/smithers-seed/package.json /usr/share/ultrafuzz/material-inputs/smithers-package.json
COPY packages/modal/smithers-seed/package-lock.json /usr/share/ultrafuzz/material-inputs/smithers-package-lock.json

RUN cd /usr/share/ultrafuzz \
    && sha256sum -c toolchain-materials.sha256 \
    && printf '%s  %s\n' \
      9084e643333bcc6bd59f2a026549634d76e8eecc39217042f40a8496fb308de3 material-inputs/pnpm-lock.yaml \
      d866b21b55d75821a8c35c422a1130218efb613bd4283cf3fd1115d80699e856 material-inputs/pnpm-workspace.yaml \
      f2315b015b292c47bffe768b1c9e69c6d351eb6ac64b467ece937336e88dd391 material-inputs/package.json \
      bb06e075801fb97ae6318e9ba821ad2db960bfa2df991145e94ac8829a9f0862 material-inputs/modal-package.json \
      9e2232f20092d3ab283357d1fa497b9cb5dc8abe5c1201509375691ddd4088cb material-inputs/security-requirements.lock \
      0ff8d3b24cec3090fba20f5131e3478a42f9186407e2904086bddf5ae8925012 material-inputs/smithers-package.json \
      b8962ee5b44ead8b43ce38c97268da7fcb3d00f64aeb4a214b992ae2f31c025a material-inputs/smithers-package-lock.json \
      | sha256sum -c -

RUN printf '%s\n' \
      'Types: deb' \
      'URIs: https://snapshot.ubuntu.com/ubuntu/20250813T000000Z/' \
      'Suites: noble noble-updates noble-security' \
      'Components: main universe' \
      'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg' \
      > /etc/apt/sources.list.d/ubuntu.sources \
    && rm -f /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources.dpkg-dist \
    && printf '%s\n' 'Acquire::Check-Valid-Until "false";' > /etc/apt/apt.conf.d/99ultrafuzz-snapshot \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      bash build-essential ca-certificates curl git jq libssl3t64 \
      python3 python3-pip python3-venv ripgrep tar unzip xz-utils zstd \
    && rm -rf /var/lib/apt/lists/*

RUN command -v zstd \
    && zstd --version

RUN curl --proto '=https' --tlsv1.2 -fsSL \
      'https://nodejs.org/dist/v22.23.1/node-v22.23.1-linux-x64.tar.xz' \
      -o /tmp/node.tar.xz \
    && printf '%s  %s\n' \
      9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578 /tmp/node.tar.xz \
      | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz

RUN curl --proto '=https' --tlsv1.2 -fsSL \
      'https://github.com/foundry-rs/foundry/releases/download/v1.7.1/foundry_v1.7.1_linux_amd64.tar.gz' \
      -o /tmp/foundry.tar.gz \
    && printf '%s  %s\n' \
      cf7e688ed0c4c48adffca788b496076e31060b67ac5afe1e43dbb5499c20c88b /tmp/foundry.tar.gz \
      | sha256sum -c - \
    && tar -xzf /tmp/foundry.tar.gz -C /usr/local/bin \
    && rm /tmp/foundry.tar.gz

RUN curl --proto '=https' --tlsv1.2 -fsSL \
      'https://github.com/Recon-Fuzz/recon-fuzzer/releases/download/v0.4.17/recon-linux-x86_64.tar.gz' \
      -o /tmp/recon.tar.gz \
    && printf '%s  %s\n' \
      8b7c8bee2ff9da88ce5eada7f021b8c933f2c6c0d6c597e2171cef84cd9884de /tmp/recon.tar.gz \
      | sha256sum -c - \
    && tar -xzf /tmp/recon.tar.gz -C /usr/local/bin \
    && rm /tmp/recon.tar.gz

RUN python3 -m venv /opt/security-venv \
    && /opt/security-venv/bin/pip install --no-cache-dir --require-hashes \
      -r /usr/share/ultrafuzz/material-inputs/security-requirements.lock

FROM node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a AS node-tools

WORKDIR /opt/ultrafuzz
COPY . .
RUN corepack enable \
    && pnpm install --frozen-lockfile --prod --filter @ultrafuzz/modal...

FROM toolchain

COPY --from=node-tools /opt/ultrafuzz/node_modules /opt/ultrafuzz/node_modules
COPY --from=node-tools /opt/ultrafuzz/packages/modal/node_modules /opt/ultrafuzz/packages/modal/node_modules

RUN test -x /opt/ultrafuzz/packages/modal/node_modules/@anthropic-ai/claude-code/bin/claude.exe \
    && ln -s /opt/ultrafuzz/packages/modal/node_modules/@anthropic-ai/claude-code/bin/claude.exe /usr/local/bin/claude \
    && test -x /opt/ultrafuzz/packages/modal/node_modules/@moonshot-ai/kimi-code/dist/main.mjs \
    && ln -s /opt/ultrafuzz/packages/modal/node_modules/@moonshot-ai/kimi-code/dist/main.mjs /usr/local/bin/kimi \
    && test -x /opt/ultrafuzz/packages/modal/node_modules/@openai/codex/bin/codex.js \
    && ln -s /opt/ultrafuzz/packages/modal/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex \
    && test -x /opt/ultrafuzz/packages/modal/node_modules/bun/bin/bun.exe \
    && ln -s /opt/ultrafuzz/packages/modal/node_modules/bun/bin/bun.exe /usr/local/bin/bun \
    && test -x /opt/ultrafuzz/packages/modal/node_modules/bun/bin/bunx.exe \
    && ln -s /opt/ultrafuzz/packages/modal/node_modules/bun/bin/bunx.exe /usr/local/bin/bunx \
    && test -x /opt/ultrafuzz/packages/modal/node_modules/pnpm/bin/pnpm.mjs \
    && ln -s /opt/ultrafuzz/packages/modal/node_modules/pnpm/bin/pnpm.mjs /usr/local/bin/pn \
    && ln -s /opt/ultrafuzz/packages/modal/node_modules/pnpm/bin/pnpm.mjs /usr/local/bin/pnpm \
    && test -x /opt/ultrafuzz/packages/modal/node_modules/pnpm/bin/pnpx.mjs \
    && ln -s /opt/ultrafuzz/packages/modal/node_modules/pnpm/bin/pnpx.mjs /usr/local/bin/pnx \
    && ln -s /opt/ultrafuzz/packages/modal/node_modules/pnpm/bin/pnpx.mjs /usr/local/bin/pnpx \
    && test -x /opt/ultrafuzz/packages/modal/node_modules/recon-generate/dist/index.js \
    && ln -s /opt/ultrafuzz/packages/modal/node_modules/recon-generate/dist/index.js /usr/local/bin/recon-generate \
    && chmod -R a+rX,go-w /opt/ultrafuzz

RUN install -d -m 0755 -o ubuntu -g ubuntu /workspace

ENV HOME=/home/ubuntu
USER ubuntu
WORKDIR /workspace
CMD ["bash"]

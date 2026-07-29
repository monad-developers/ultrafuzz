FROM ubuntu:24.04

ARG NODE_VERSION=22.23.1
ARG FOUNDRY_VERSION=1.7.1
ARG RECON_VERSION=0.4.17
ARG ECHIDNA_VERSION=2.3.2
ARG MEDUSA_VERSION=1.5.1

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH=/usr/local/bin:/opt/security-venv/bin:/home/ubuntu/.local/bin:$PATH
ENV DISABLE_AUTOUPDATER=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash build-essential ca-certificates curl git jq libgmp10 libssl3t64 \
      python3 python3-pip python3-venv ripgrep tar unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && npm install -g \
      pnpm@11.1.1 bun@1.3.14 @openai/codex@0.144.3 \
      @anthropic-ai/claude-code@2.1.207 @moonshot-ai/kimi-code@0.29.1 \
      recon-generate@0.0.42

RUN curl -fsSL "https://github.com/foundry-rs/foundry/releases/download/v${FOUNDRY_VERSION}/foundry_v${FOUNDRY_VERSION}_linux_amd64.tar.gz" -o /tmp/foundry.tar.gz \
    && tar -xzf /tmp/foundry.tar.gz -C /usr/local/bin \
    && rm /tmp/foundry.tar.gz

RUN curl -fsSL "https://github.com/Recon-Fuzz/recon-fuzzer/releases/download/v${RECON_VERSION}/recon-linux-x86_64.tar.gz" -o /tmp/recon.tar.gz \
    && tar -xzf /tmp/recon.tar.gz -C /usr/local/bin \
    && rm /tmp/recon.tar.gz

RUN curl -fsSL "https://github.com/crytic/echidna/releases/download/v${ECHIDNA_VERSION}/echidna-${ECHIDNA_VERSION}-x86_64-linux.tar.gz" -o /tmp/echidna.tar.gz \
    && tar -xzf /tmp/echidna.tar.gz -C /usr/local/bin \
    && rm /tmp/echidna.tar.gz

RUN curl -fsSL "https://github.com/crytic/medusa/releases/download/v${MEDUSA_VERSION}/medusa-linux-x64.tar.gz" -o /tmp/medusa.tar.gz \
    && tar -xzf /tmp/medusa.tar.gz -C /usr/local/bin \
    && rm /tmp/medusa.tar.gz

RUN python3 -m venv /opt/security-venv \
    && /opt/security-venv/bin/pip install --no-cache-dir \
      slither-analyzer==0.11.5 \
      "covg-eval @ git+https://github.com/Recon-Fuzz/recon-magic-framework.git@f92ad26ff857526d221c3e8488c5aea2a20e8fdf#subdirectory=tools/covg_eval"

RUN install -d -m 0755 -o ubuntu -g ubuntu /workspace

ENV HOME=/home/ubuntu
USER ubuntu
WORKDIR /workspace
CMD ["bash"]

# Test image for the Modal integration test. It is not the worker image.
# It has Bun, Git and a fake OpenCode command, so a run calls no model and needs no real key.
# Modal builds these lines without a build context, so no file can be copied in.
# The test puts tests/fixtures/modal/opencode into the marked line as base64 text.
FROM oven/bun:1.4.4-slim

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 --shell /usr/sbin/nologin ultrafuzz

RUN echo "@OPENCODE_BASE64@" | base64 -d > /usr/local/bin/opencode \
    && chmod 755 /usr/local/bin/opencode \
    && test "$(opencode --version)" = "0.0.0-test"

WORKDIR /run-data

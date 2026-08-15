ARG BASE_IMAGE
FROM node:22-bookworm AS builder

WORKDIR /opt/ultrafuzz
COPY . .
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate && \
    pnpm install --frozen-lockfile && \
    pnpm --filter @ultrafuzz/cli... build && \
    pnpm --filter @ultrafuzz/evmbench build
RUN mkdir -p /opt/ultrafuzz-smithers && \
    node --input-type=module -e 'import { writeFileSync } from "node:fs"; import { renderSmithersPackageJson } from "./packages/runtime/dist/smithers-package.js"; writeFileSync("/opt/ultrafuzz-smithers/package.json", renderSmithersPackageJson())' && \
    npm install --prefix /opt/ultrafuzz-smithers --ignore-scripts --package-lock=false --no-audit --no-fund --loglevel=error

FROM ${BASE_IMAGE}
ARG PROFILE
ARG MODEL
ARG REASONING
ARG ULTRAFUZZ_COMMIT
ARG EVMBENCH_COMMIT
ARG FRONTIER_EVALS_COMMIT

COPY --from=builder /opt/ultrafuzz /opt/ultrafuzz
COPY --from=builder /opt/ultrafuzz-smithers /opt/ultrafuzz-smithers
COPY benchmarks/evmbench/profiles/${PROFILE}.json /opt/ultrafuzz/evmbench-profile.json
RUN ["node", "--input-type=module", "-e", "import{readFileSync}from'node:fs';import{writeFileDurable}from'/opt/ultrafuzz/packages/artifacts/dist/index.js';import{parseEvmbenchProfileBytes,serializeEvmbenchProfile}from'/opt/ultrafuzz/packages/evmbench/dist/index.js';const p='/opt/ultrafuzz/evmbench-profile.json';const model=process.env.MODEL;const reasoning=process.env.REASONING;if(!model||!reasoning)throw new Error('missing profile override');const base=parseEvmbenchProfileBytes(readFileSync(p),p);writeFileDurable(p,serializeEvmbenchProfile({...base,model,reasoning}))"]

LABEL org.opencontainers.image.revision="${ULTRAFUZZ_COMMIT}" \
      org.ultrafuzz.evmbench.commit="${EVMBENCH_COMMIT}" \
      org.ultrafuzz.frontier-evals.commit="${FRONTIER_EVALS_COMMIT}"

WORKDIR /home/agent

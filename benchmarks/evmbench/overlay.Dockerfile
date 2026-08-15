ARG BASE_IMAGE
FROM node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a AS builder

WORKDIR /opt/ultrafuzz
COPY . .
RUN corepack enable && \
    pnpm install --frozen-lockfile && \
    pnpm --filter @ultrafuzz/cli... build && \
    pnpm --filter @ultrafuzz/evmbench build
RUN node packages/modal/scripts/prepare-smithers-seed.mjs /opt/ultrafuzz-smithers

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

# Use The Dashboard

The dashboard is a local loopback operator surface over the same beta product
state used by the CLI. Start it with:

```bash
ultrafuzz dashboard --project <project>
```

Open the complete printed `/dashboard#session=...` URL in a local browser. The
fragment is a bearer credential: do not paste it into logs, tickets, or chat.
The browser removes it from the address and history after bootstrap and keeps
it only in that tab's `sessionStorage`, so refreshes continue to work. Reopen
the newly printed URL after restarting the dashboard or when the page reports
that its session token is unavailable.

## Prepare A Run

Start from a validated project:

```bash
ultrafuzz init --project <project>
ultrafuzz validate --project <project>
ultrafuzz references sync --project <project>
ultrafuzz run --project <project> --run-id <run-id>
```

The dashboard should read the same product surfaces as the CLI:

```text
ultrafuzz.toml
.ultrafuzz/topology.yml
.ultrafuzz/prompts/**
.ultrafuzz/references.yml
.ultrafuzz/runs/**
```

## Inspect The Graph

The dashboard shows logical topology nodes by default. Expanded strategy loops
and model fan-out appear in technical details, while graph edits map back to
`.ultrafuzz/topology.yml`.

You can inspect the same run evidence from the CLI with:

```bash
ultrafuzz ps --project <project>
ultrafuzz inspect --project <project> <run-id>
ultrafuzz report --project <project> <run-id>
```

## Edit Project Assets

Dashboard editors save only product inputs:

- Runtime settings in root `ultrafuzz.toml`.
- Campaign graph changes in `.ultrafuzz/topology.yml`.
- Prompt text in `.ultrafuzz/prompts/**`.
- Reference catalog state through the explicit references flow.

Edits validate before they are accepted and must not leave partial writes after
failed validation. For the CLI equivalent, edit the files directly and run:

```bash
ultrafuzz validate --project <project>
```

## Run Product Operations

Dashboard command jobs must map to current CLI operations:

```text
validate
run
references status
references sync
references update
ps
inspect
resume
replay
fork
report
materialize
clean
```

Starting a run from the dashboard first shows a confirmation containing the
resolved target, providers, and configured budget. Confirming appends a launch
record to `.ultrafuzz/dashboard-audit.jsonl` before dispatch. This does not
pause or constrain agents after dispatch; agents retain the configured
bypass-permissions/YOLO execution mode.

Other destructive or target-repository-mutating jobs require confirmation. In
the CLI, materialization requires explicit reviewed copies:

```bash
ultrafuzz materialize --project <project> <run-id> \
  --copy artifacts/<node>/stdout.txt:reviewed/stdout.txt \
  --yes
```

Cleanup removes only selected generated `.ultrafuzz/**` paths:

```bash
ultrafuzz clean --project <project> <run-id> --select runs/<run-id> --yes
```

## Troubleshoot Security Diagnostics

Every dashboard API and live-event request is authenticated, including reads.
If a browser tab loses its credential, use the launch URL printed by the
currently running dashboard instead of trying to recover a token from
`/api/session`.

Unexpected API failures display a correlation ID without internal paths,
stacks, command output, or secrets. Match that ID against the dashboard
process's redacted server diagnostic. Raw stdout, stderr, and rendered prompts
are likewise redacted in API responses; their immutable run artifacts are not
rewritten.

The dashboard also reports Content Security Policy violations through its
authenticated, bounded `/api/csp-violations` view. Any unexpected entry during
local development or dashboard CI should be treated as a regression, rather
than weakening the `img-src 'self'` policy to make it disappear.

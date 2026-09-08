import type { RunMetadataAuditProfile } from "@ultrafuzz/artifacts";

import { assertEvmbenchJsonSchema } from "./schema-registry.js";
import { assertEvmbenchDocumentSemantics } from "./semantic-gates.js";

export const ULTRAFUZZ_CLI_RESULT_VERSION = "ultrafuzz.cli.result.v2" as const;
export const EVMBENCH_CLI_RESULT_JSON_SCHEMA_ID = "urn:ultrafuzz:schema:evmbench:ultrafuzz-cli-result:1" as const;
export const EVMBENCH_CLI_EXPECTED_COMMAND_CONTEXT_GATE = "evmbench-cli-result-expected-command" as const;

export interface EvmbenchCliDiagnostic {
  code: string;
  message: string;
  severity: "error" | "warning" | "info";
  source: string;
  path?: string;
}

export interface EvmbenchInitData {
  project_root: string;
  created: string[];
  preserved: string[];
  overwritten: string[];
}

export interface EvmbenchRunData {
  run_id: string;
  run_root: string;
  status: string;
  source_run_id?: string;
  graph_fingerprint: string;
  config_fingerprint: string;
  workflow_ids: string[];
}

export interface EvmbenchResumeData {
  run_id: string;
  workflow_run_id?: string;
  workflow_path?: string;
  action: "resume";
  submitted: boolean;
}

export type EvmbenchStatusVerdict =
  | "launch-incomplete"
  | "done"
  | "degraded"
  | "running-healthy"
  | "progressing"
  | "stalled"
  | "orphaned"
  | "cancel-pending"
  | "blocked"
  | "waiting-quota"
  | "paused"
  | "cancelled"
  | "failed";

export interface EvmbenchStatusData {
  run_id: string;
  run_root: string;
  status: string;
  created_at?: string;
  started_at?: string;
  finished_at?: string;
  source_run_id?: string;
  audit_profile?: RunMetadataAuditProfile;
  workflow_ids: string[];
  workflow_run_id?: string;
  workflow_status: string;
  verdict: EvmbenchStatusVerdict;
  reason: string;
  counts: {
    finished: number;
    in_progress: number;
    pending: number;
    failed: number;
    waiting_approval: number;
    waiting_event: number;
    waiting_timer: number;
    skipped: number;
    other: number;
    total: number;
  };
  model_mix: Array<{ engine: string; model: string; attempts: number; quota_parked: boolean }>;
  throughput: {
    recent_finished: number;
    window_ms: number;
    total_finished: number;
    last_finished_at_ms: number | null;
  };
  progress: {
    percent: number;
    finished: number;
    in_progress: number;
    pending: number;
    failed: number;
    skipped: number;
    remaining: number;
    total: number;
  };
  eta:
    | {
        available: true;
        seconds: number;
        basis: "recent-throughput" | "run-throughput" | "no-remaining-nodes";
        unavailable_reason: null;
      }
    | {
        available: false;
        seconds: null;
        basis: null;
        unavailable_reason:
          "run-terminal" | "run-paused" | "no-node-counts" | "no-finished-nodes" | "no-observed-elapsed-time";
      };
  current_step: {
    node_id: string | null;
    iteration: number | null;
    started_at: string | null;
    elapsed_seconds: number | null;
    running_count: number;
  };
  gating: Array<{ node_id: string; iteration: number; state: string; detail: string | null }>;
  gating_omitted: number;
  quota: { parked_count: number; parked_node_ids: string[]; reset_at_ms: number | null } | null;
  attention?: {
    operation: string;
    op_id: string | null;
    crossed_count: number;
    blocking_count: number;
    revertible_count: number;
    warning_count: number;
    late_completion: boolean;
    archived_by_op: string | null;
    timestamp_ms: number;
  };
  information?: { operation: string; warning_count: number; timestamp_ms: number };
  oneshot_control?: {
    kind: "steer" | "restart";
    status: string;
    message_id?: string;
    restarted_as_run_id?: string;
    error?: string;
    timestamp_ms: number;
  };
  started_by?: { harness?: string; session_id?: string; detected?: true };
  generated_at_ms: number;
}

export interface EvmbenchReportData {
  markdown_path: string;
  json_path: string;
  source: "verified-agent-report";
}

export interface EvmbenchCliDataMap {
  init: EvmbenchInitData;
  run: EvmbenchRunData;
  resume: EvmbenchResumeData;
  status: EvmbenchStatusData;
  report: EvmbenchReportData;
}

export type EvmbenchCliCommand = keyof EvmbenchCliDataMap;

export type EvmbenchCliResult = {
  [Command in EvmbenchCliCommand]: {
    schema_version: typeof ULTRAFUZZ_CLI_RESULT_VERSION;
    command: Command;
    ok: true;
    diagnostics: EvmbenchCliDiagnostic[];
    data: EvmbenchCliDataMap[Command];
  };
}[EvmbenchCliCommand];

/** Validate the CLI-owned shared contract, then apply the caller's expected-command context gate. */
export function parseEvmbenchCliResult<Command extends EvmbenchCliCommand>(
  command: Command,
  value: unknown
): EvmbenchCliDataMap[Command] {
  assertEvmbenchJsonSchema(EVMBENCH_CLI_RESULT_JSON_SCHEMA_ID, value, "Ultrafuzz CLI result for EVMBench");
  assertEvmbenchDocumentSemantics(EVMBENCH_CLI_RESULT_JSON_SCHEMA_ID, value);
  const envelope = value as EvmbenchCliResult;
  if (envelope.command !== command) {
    throw new Error(`${EVMBENCH_CLI_EXPECTED_COMMAND_CONTEXT_GATE}: expected ${command}; received ${envelope.command}`);
  }
  return envelope.data as EvmbenchCliDataMap[Command];
}

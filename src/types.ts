export const VERSION = "0.2.0";
export const HARNESSES = ["claude-code", "opencode", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

export interface RepositoryConfig {
  url: string;
  results_repository: string;
  scope?: string;
}

export interface ModalConfig {
  app: string;
  environment?: string;
  image?: string;
  cpu: number;
  memory_mib: number;
  timeout_seconds: number;
}

export interface Config {
  defaults: { harness: Harness; model: string; effort?: string; audit_profile: string };
  modal: ModalConfig;
  openrouter: { key_env: string };
  repositories: Record<string, RepositoryConfig>;
}

export interface Profile {
  name: string;
  description: string;
  harnesses: Harness[];
  available: boolean;
  requires_properties?: boolean;
  directory: string;
}

export interface InputRecord {
  name: string;
  path: string;
  sha256: string;
  source_run?: string;
}

export interface Usage {
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  cost_provenance: string;
}

export interface Continuation {
  trigger: "missing-report";
  sent_at: string;
  minutes_left: number;
  exit_code: number | null;
  report_after: boolean;
}

export interface RunRecord {
  schema: "ultrafuzz.run.v2";
  id: string;
  label: string;
  ultrafuzz_version: string;
  source: { repository: string; commit: string; scope?: string };
  profile: { name: string; sha256: string };
  harness: { name: Harness; version?: string; model: string; effort?: string };
  state: "prepared" | "launching" | "running" | "finished";
  status: "pending" | "succeeded" | "failed";
  end: "completed" | "error" | "timeout" | "cancelled" | "lost" | null;
  exit_code: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  last_observed_at: string | null;
  session_id: string | null;
  continuation: Continuation | null;
  inputs: InputRecord[];
  omitted: Array<{ path: string; reason: string }>;
  redactions?: number;
  usage: Usage;
  modal: ModalConfig & { sandbox_id: string | null; volume_name: string };
  publication: {
    state: "pending" | "published" | "failed";
    repository: string;
    branch: string;
    path: string;
    pr_url: string | null;
    error?: string;
  };
  error?: string;
}

// This file is staged on the per-run Volume. Credentials are never part of it.
export interface WorkerJob {
  record: RunRecord;
  deadline_at: string;
  workspace: string;
  output_dir: string;
  profile_dir: string;
  reference_dir: string;
  prompt_path: string;
}

export interface LaunchOptions {
  repository: string;
  label: string;
  audit_profile?: string;
  harness?: Harness;
  model?: string;
  effort?: string;
  properties?: string;
  key_env?: string;
  inputs?: Array<{ name: string; path?: string; repository?: string; revision?: string }>;
  timeout_seconds?: number;
}

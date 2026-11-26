/** Keep this equal to the version in package.json. A test checks it. */
export const VERSION = "0.2.0-experimental";
export const HARNESSES = ["claude-code", "opencode", "codex"] as const;
export type Harness = (typeof HARNESSES)[number];

export const EXECUTORS = ["docker", "modal"] as const;
export type ExecutorName = (typeof EXECUTORS)[number];

export interface RepositoryConfig {
  url: string;
  /** Optional: only needed for runs launched with publication enabled. */
  results_repository?: string;
  scope?: string;
  /** Optional commit, tag or branch to audit. Without it the default branch is cloned. */
  revision?: string;
}

/** Settings every executor shares. The timeout covers continuation and export time. */
export interface ExecutorResources {
  cpu: number;
  memory_mib: number;
  timeout_seconds: number;
  image?: string;
}
export type DockerConfig = ExecutorResources;
export interface ModalConfig extends ExecutorResources {
  app: string;
  environment?: string;
}

export interface Config {
  defaults: { executor: ExecutorName; harness: Harness; model: string; effort?: string; audit_profile: string };
  /** Only the table of the selected executor is required. */
  docker?: DockerConfig;
  modal?: ModalConfig;
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
  /** Host-owned. Since when the platform has not known a run that the host holds as running. Absent or null when it knows the run. */
  unknown_since?: string | null;
  session_id: string | null;
  continuation: Continuation | null;
  inputs: InputRecord[];
  omitted: Array<{ path: string; reason: string }>;
  redactions?: number;
  usage: Usage;
  executor: ExecutorRecord;
  collection: Collection;
  publication: {
    /** "disabled" is the normal state of a local-only run. */
    state: "disabled" | "pending" | "published" | "failed";
    repository: string | null;
    branch: string;
    path: string;
    pr_url: string | null;
    error?: string;
  };
  error?: string;
}

/** Local collection outcome. It is kept apart from the optional publication outcome. */
export interface Collection {
  state: "pending" | "collected" | "failed";
  /**
   * Absolute local directory of the collected package, once one exists.
   * "collected" with a null path means that the run never reached the executor, so nothing exists to collect.
   */
  path: string | null;
  /** Absolute local path of a nonempty report.md inside the package, or null. */
  report: string | null;
  error?: string;
}

/** Resolved resources and stable handles of the executor that owns a run. */
interface ExecutorHandles extends ExecutorResources {
  /** The per-run durable store: a Modal Volume or a named Docker volume. */
  volume_name: string;
  /** Modal sandbox ID or Docker container ID. It is null until the executor reports it. */
  runtime_id: string | null;
}
export type ExecutorRecord =
  | (ExecutorHandles & { name: "modal"; app: string; environment?: string })
  | (ExecutorHandles & { name: "docker"; container_name: string });

// This file is staged in the per-run durable store. Credentials are never part of it.
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
  executor?: ExecutorName;
  /** Commit, tag or branch to audit; overrides the repository's configured revision. */
  revision?: string;
  /** Publication is off unless this is true. */
  publish?: boolean;
  harness?: Harness;
  model?: string;
  effort?: string;
  properties?: string;
  key_env?: string;
  inputs?: Array<{ name: string; path?: string; repository?: string; revision?: string }>;
  timeout_seconds?: number;
}

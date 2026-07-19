#!/usr/bin/env node

import { runEvmbenchAdapter } from "./adapter.js";

const args = process.argv.slice(2);
await runEvmbenchAdapter({
  auditRoot: option(args, "--audit-root") ?? "/home/agent/audit",
  submissionRoot: option(args, "--submission-root") ?? "/home/agent/submission",
  profilePath: option(args, "--profile") ?? "/opt/ultrafuzz/evmbench-profile.json",
  cliPath: option(args, "--cli") ?? "/opt/ultrafuzz/packages/cli/dist/index.js"
});

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

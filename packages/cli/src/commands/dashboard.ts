import { Command, Flags } from "@oclif/core";
import { serveDashboard } from "@ultrafuzz/dashboard";

import { projectRoot } from "../command-shared.js";

export default class Dashboard extends Command {
  static override summary = "Serve the local Ultrafuzz dashboard and API";
  static override flags = {
    project: Flags.string({
      summary: "Project root"
    }),
    host: Flags.string({
      summary: "Loopback host to bind",
      default: "127.0.0.1"
    }),
    port: Flags.integer({
      summary: "Port to bind",
      default: 3875
    }),
    "run-id": Flags.string({
      summary: "Run ID to inspect"
    }),
    "no-live": Flags.boolean({
      summary: "Disable live event polling"
    })
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Dashboard);
    const handle = await serveDashboard({
      projectRoot: projectRoot(flags),
      host: flags.host,
      port: flags.port,
      runId: flags["run-id"],
      liveUpdates: flags["no-live"] !== true,
      env: process.env
    });
    this.log(`Dashboard: ${handle.url}`);
    this.log(`Run: ${handle.runId}`);
    await waitForShutdown(handle.close);
  }
}

function waitForShutdown(close: () => Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    let closing = false;
    const shutdown = () => {
      if (closing) {
        return;
      }
      closing = true;
      close()
        .catch(() => undefined)
        .finally(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

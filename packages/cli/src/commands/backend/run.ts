import { Args, Command } from "@oclif/core";
import { runCheckpointedBackend } from "@ultrafuzz/runtime";

/** Internal campaign primitive; stdout/stderr are durable files, not CLI JSON. */
export default class BackendRun extends Command {
  static override summary = "Run a backend with a task-scoped completion checkpoint";
  static override hidden = true;
  static override strict = false;
  static override args = { checkpoint: Args.string({ required: true }) };

  async run(): Promise<void> {
    const { args } = await this.parse(BackendRun);
    const separator = this.argv.indexOf("--");
    if (separator !== 1) throw new Error("usage: ultrafuzz backend run <checkpoint> -- <command> [args...]");
    // Oclif's parsed argv can consume a backend's own second `--`. Preserve
    // the command vector exactly; never reparse it as Ultrafuzz flags.
    const command = this.argv.slice(separator + 1);
    const code = await runCheckpointedBackend(args.checkpoint, command);
    if (code !== 0) this.exit(code);
  }
}

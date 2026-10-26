import { Command, Flags } from "@oclif/core";
import {
  commandInvocationHook,
  commandInvocationRegistryFromEnvironment,
  commandInvocationStatus
} from "@ultrafuzz/runtime";

/** Internal provider hook, also usable by the model to inspect a durable handle. */
export default class CommandHook extends Command {
  static override hidden = true;
  static override summary = "Inspect or update an agent command invocation";
  static override flags = { status: Flags.string({ summary: "Poll an invocation handle" }) };

  async run(): Promise<void> {
    const { flags } = await this.parse(CommandHook);
    try {
      if (flags.status !== undefined) {
        this.log(JSON.stringify(commandInvocationStatus(commandInvocationRegistryFromEnvironment(), flags.status)));
        return;
      }
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        const buffer = Buffer.from(chunk as Uint8Array);
        bytes += buffer.length;
        if (bytes > 1024 * 1024) throw new Error("hook input limit exceeded");
        chunks.push(buffer);
      }
      this.log(JSON.stringify(commandInvocationHook(JSON.parse(Buffer.concat(chunks).toString("utf8")))));
    } catch {
      // Provider hooks fail open on operational errors. Surface the missing
      // protection rather than misreporting it as a successful reservation.
      this.log(
        JSON.stringify({
          systemMessage: "ultrafuzz.command_invocation unavailable: hook failed; command guard inactive"
        })
      );
    }
  }
}

import { mkdir, rm } from "node:fs/promises";
await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
for (const entry of ["src/cli.ts", "src/worker.ts"]) {
  const result = await Bun.build({ entrypoints: [entry], outdir: "dist", target: "bun", external: ["modal"] });
  if (!result.success) throw new Error(result.logs.join("\n"));
}

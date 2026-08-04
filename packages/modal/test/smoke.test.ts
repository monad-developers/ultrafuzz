import fs from "node:fs";

import { describe, expect, it } from "vitest";

import { DEFAULT_MODAL_IMAGE, type ModelProvider } from "../src/defaults.js";
import { remoteAuthDir, remoteAuthPath } from "../src/layout.js";
import {
  MODAL_SMOKE_ENTRY_PATH,
  cloudFailureResult,
  modalSmokeEntrypointCommand,
  runModalSmoke,
  type ModalSmokeCheckpoint,
  type ModalSmokeCompletion,
  type ModalSmokeDriver,
  type ModalSmokeLaunch,
  type ModalSmokePhase,
  type ModalSmokePrepared
} from "../src/smoke.js";

describe("Modal smoke orchestration", () => {
  it("terminates a fresh worker and resumes once on the same durable volume", async () => {
    const driver = new ContractDriver();

    const result = await runModalSmoke("openai", driver);

    expect(result).toEqual({
      schema_version: "ultrafuzz.modal.smoke-result.v1",
      status: "passed",
      provider: "openai",
      checks: {
        production_image: true,
        production_entrypoint: true,
        non_root: true,
        durable_storage: true,
        provider_auth: true,
        same_volume_resume: true,
        completed_work_not_repeated: true,
        single_launch_owner: true
      },
      diagnostics: { completed_units: 1, repeated_units: 0, launch_owners: 1 }
    });
    expect(driver.events).toEqual([
      "prepare:openai",
      "launch:fresh:0",
      "checkpoint",
      "terminate:fresh-0",
      "launch:resume:0",
      "launch:resume:1",
      "completion:resume-0",
      "cleanup"
    ]);
  });

  it("fails closed if completed work repeats or launch ownership is ambiguous", async () => {
    const repeated = new ContractDriver();
    repeated.completion = { ...repeated.completion, completedUnits: 2, repeatedUnits: 1 };
    const repeatedResult = await runModalSmoke("anthropic", repeated);
    expect(repeatedResult.status).toBe("failed");
    expect(repeatedResult.checks.completed_work_not_repeated).toBe(false);

    const ambiguous = new ContractDriver();
    ambiguous.resumeOwners = 2;
    const ambiguousResult = await runModalSmoke("openai", ambiguous);
    expect(ambiguousResult.status).toBe("failed");
    expect(ambiguousResult.checks.single_launch_owner).toBe(false);
  });

  it("keeps the production image check tied to the published image name", async () => {
    const driver = new ContractDriver();
    driver.imageName = "ultrafuzz-security-runner:kimi-candidate";

    const result = await runModalSmoke("kimi", driver);

    expect(result.status).toBe("failed");
    expect(result.checks.production_image).toBe(false);
    expect(result.checks.production_entrypoint).toBe(true);
  });

  it("reports only an allowlisted cloud failure stage", () => {
    const result = cloudFailureResult("openai", "checkpoint");

    expect(result.status).toBe("failed");
    expect(result.diagnostics).toEqual({
      completed_units: 0,
      repeated_units: 0,
      launch_owners: 0,
      failure_code: "cloud-operation-failed",
      failure_stage: "checkpoint"
    });
  });
});

describe("provider-isolated smoke entrypoints", () => {
  it.each([
    ["openai", "anthropic"],
    ["anthropic", "openai"],
    ["deepseek", "openai"],
    ["kimi", "openai"]
  ] as const)("stages only %s subscription auth", (selected, unselected) => {
    const fresh = modalSmokeEntrypointCommand(selected, "fresh");
    const resume = modalSmokeEntrypointCommand(selected, "resume");

    for (const command of [fresh, resume]) {
      expect(command).toContain(remoteAuthPath(selected));
      expect(command).not.toContain(remoteAuthPath(unselected));
      if (selected === "kimi") {
        expect(command).toContain(`${remoteAuthDir(selected)}/device_id`);
        expect(command).not.toContain(`${remoteAuthDir(selected)}/credentials/kimi-code.json`);
      }
      expect(command).toContain("runuser -u ubuntu");
      expect(command).toContain(MODAL_SMOKE_ENTRY_PATH);
    }
  });
});

describe("dedicated cloud command", () => {
  it("keeps real Modal smoke out of normal unit tests and other CLI paths", () => {
    const cliSource = fs.readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    const smokeSources = ["smoke.ts", "smoke-modal.ts", "smoke-worker.ts"].map((name) =>
      fs.readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8")
    );
    const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(cliSource.match(/import\("\.\/smoke-modal\.js"\)/gu)).toHaveLength(1);
    expect(cliSource).not.toMatch(/^import .*smoke-modal/mu);
    expect(packageJson.scripts.test).toBe("vitest run");
    expect(packageJson.scripts.smoke).toContain("dist/cli.js smoke");
    expect(packageJson.scripts.typecheck).toBe(
      "pnpm --filter @ultrafuzz/modal^... build && tsc -p tsconfig.json --noEmit --pretty false"
    );
    expect(packageJson.scripts.test).not.toContain("smoke");
    expect(smokeSources.every((source) => !source.includes("process.env"))).toBe(true);
  });
});

class ContractDriver implements ModalSmokeDriver {
  readonly events: string[] = [];
  imageName = DEFAULT_MODAL_IMAGE;
  resumeOwners = 1;
  checkpoint: ModalSmokeCheckpoint = {
    nonRoot: true,
    durableStorage: true,
    providerAuth: "openai",
    completedUnits: 1
  };
  completion: ModalSmokeCompletion = {
    ...this.checkpoint,
    repeatedUnits: 0
  };

  async prepare(provider: ModelProvider): Promise<ModalSmokePrepared> {
    this.events.push(`prepare:${provider}`);
    this.checkpoint = { ...this.checkpoint, providerAuth: provider };
    this.completion = { ...this.completion, providerAuth: provider };
    return { imageName: this.imageName, entryPath: MODAL_SMOKE_ENTRY_PATH, volumeIdentity: "volume-one" };
  }

  async launch(prepared: ModalSmokePrepared, phase: ModalSmokePhase, candidate: number): Promise<ModalSmokeLaunch> {
    this.events.push(`launch:${phase}:${candidate}`);
    return {
      owned: phase === "fresh" || candidate < this.resumeOwners,
      sandboxIdentity: `${phase}-${candidate}`,
      volumeIdentity: prepared.volumeIdentity
    };
  }

  async waitForCheckpoint(_launch: ModalSmokeLaunch): Promise<ModalSmokeCheckpoint> {
    this.events.push("checkpoint");
    return this.checkpoint;
  }

  async terminate(launch: ModalSmokeLaunch): Promise<void> {
    this.events.push(`terminate:${launch.sandboxIdentity}`);
  }

  async waitForCompletion(launch: ModalSmokeLaunch): Promise<ModalSmokeCompletion> {
    this.events.push(`completion:${launch.sandboxIdentity}`);
    return this.completion;
  }

  async cleanup(_prepared: ModalSmokePrepared, _launches: ModalSmokeLaunch[]): Promise<void> {
    this.events.push("cleanup");
  }
}

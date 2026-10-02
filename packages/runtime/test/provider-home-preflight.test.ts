import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ResolvedConfig } from "@ultrafuzz/config";

import { initProject } from "../src/init.js";
import { fixProviderHomes, predictedProviderHome, providerHomeProblems } from "../src/provider-home-preflight.js";
import { validateProject } from "../src/validate.js";
import { temporaryRoot } from "./temporary-root.js";

const config = (agents: ResolvedConfig["agents"] = {}): ResolvedConfig => ({ agents }) as unknown as ResolvedConfig;

/** A private stand-in for the operator's HOME, so no test touches the real one. */
function privateHome(): string {
  const home = path.join(temporaryRoot("ufz-provider-home-"), "home");
  fs.mkdirSync(home, { mode: 0o700 });
  fs.chmodSync(home, 0o700);
  return home;
}

test("predictedProviderHome follows the adapters' resolution order", () => {
  const home = privateHome();
  assert.equal(predictedProviderHome("CodexAgent", config(), { HOME: home }), path.join(home, ".codex"));
  assert.equal(predictedProviderHome("ClaudeAgent", config(), { HOME: home }), path.join(home, ".claude"));
  assert.equal(predictedProviderHome("KimiAgent", config(), { HOME: home }), path.join(home, ".kimi-code"));
  assert.equal(
    predictedProviderHome("CodexAgent", config(), { HOME: home, CODEX_HOME: "/opt/codex-home" }),
    "/opt/codex-home"
  );
  assert.equal(predictedProviderHome("KimiAgent", config(), { HOME: home, KIMI_SHARE_DIR: "/opt/kimi" }), "/opt/kimi");
  // A configured config_dir or provider-home root replaces the CLI's own home.
  assert.equal(
    predictedProviderHome("ClaudeAgent", config({ ClaudeAgent: { auth: "subscription", configDir: "work/a" } }), {
      HOME: home
    }),
    path.join(home, ".ultrafuzz-provider-homes", "claude", "work", "a")
  );
  assert.equal(
    predictedProviderHome("CodexAgent", config(), { HOME: home, ULTRAFUZZ_PROVIDER_HOME_ROOT: "/srv/homes" }),
    path.join("/srv/homes", "codex")
  );
  assert.equal(
    predictedProviderHome("DeepSeekAgent", config(), { HOME: home }),
    path.join(home, ".ultrafuzz-provider-homes", "deepseek")
  );
  // Agents without a provider home, and launches without HOME (as tests run), are not predicted.
  assert.equal(predictedProviderHome("OpenRouterAgent", config(), { HOME: home }), undefined);
  assert.equal(predictedProviderHome("CodexAgent", config(), {}), undefined);
});

// #1265: Codex and Claude Code create their homes from the umask, so 755 or 775 is the norm.
test("providerHomeProblems refuses what the adapters refuse and accepts private or missing homes", () => {
  const home = privateHome();
  const env = { HOME: home };
  const codex = path.join(home, ".codex");
  const problem = () => providerHomeProblems(["CodexAgent"], config(), env)[0];

  assert.equal(problem(), undefined, "a missing home is created private by the adapter");
  fs.mkdirSync(codex, { mode: 0o700 });
  fs.chmodSync(codex, 0o700);
  assert.equal(problem(), undefined);

  for (const [mode, reason] of [
    [0o755, "has mode 755"],
    [0o775, "has mode 775"]
  ] as const) {
    fs.chmodSync(codex, mode);
    assert.deepEqual(problem(), {
      agentRef: "CodexAgent",
      home: codex,
      directory: codex,
      reason,
      fixable: true
    });
  }

  fs.rmSync(codex, { recursive: true });
  const elsewhere = path.join(temporaryRoot("ufz-provider-home-target-"), "codex");
  fs.mkdirSync(elsewhere, { mode: 0o700 });
  fs.symlinkSync(elsewhere, codex);
  assert.deepEqual(
    { reason: problem()?.reason, fixable: problem()?.fixable },
    { reason: "is not a real directory", fixable: false }
  );

  // A group-writable ancestor is refused but left for the operator.
  const shared = path.join(home, "shared");
  fs.mkdirSync(shared);
  fs.chmodSync(shared, 0o775);
  const nested = providerHomeProblems(["CodexAgent"], config(), { HOME: home, CODEX_HOME: path.join(shared, "codex") });
  assert.deepEqual(
    nested.map(({ directory, fixable }) => [directory, fixable]),
    [[shared, false]]
  );
});

test("fixProviderHomes tightens only the operator's own provider home", () => {
  const home = privateHome();
  const codex = path.join(home, ".codex");
  fs.mkdirSync(codex);
  fs.chmodSync(codex, 0o755);
  const shared = path.join(home, "shared");
  fs.mkdirSync(shared);
  fs.chmodSync(shared, 0o775);
  const problems = [
    ...providerHomeProblems(["CodexAgent"], config(), { HOME: home }),
    ...providerHomeProblems(["ClaudeAgent"], config(), { HOME: home, CLAUDE_CONFIG_DIR: path.join(shared, "claude") })
  ];

  const diagnostics = fixProviderHomes(problems);

  assert.deepEqual(
    diagnostics.map(({ code, path: directory }) => [code, directory]),
    [["PROVIDER_HOME_FIXED", codex]]
  );
  assert.equal(fs.statSync(codex).mode & 0o777, 0o700);
  assert.equal(fs.statSync(shared).mode & 0o777, 0o775, "an ancestor is never changed");
  assert.deepEqual(providerHomeProblems(["CodexAgent"], config(), { HOME: home }), []);
});

test("validate refuses a project whose agent would get an unsafe provider home, before any launch", async () => {
  const project = temporaryRoot("ufz-provider-home-project-");
  assert.equal(initProject({ projectRoot: project, force: true }).ok, true);
  const home = privateHome();
  const codex = path.join(home, ".codex");
  fs.mkdirSync(codex);
  fs.chmodSync(codex, 0o755);

  const refused = await validateProject({ projectRoot: project, env: { HOME: home } });

  assert.equal(refused.ok, false);
  const diagnostic = refused.diagnostics.find(({ code }) => code === "PROVIDER_HOME_UNSAFE");
  assert.ok(diagnostic, JSON.stringify(refused.diagnostics));
  assert.equal(diagnostic.path, codex);
  assert.ok(diagnostic.message.includes(`chmod 700 ${codex}`));
  assert.match(diagnostic.message, /ultrafuzz doctor --fix/u);
  assert.doesNotMatch(diagnostic.message, /smithers/iu);
  assert.equal(refused.value?.policy_posture.agents.status, "fail");

  fs.chmodSync(codex, 0o700);
  const accepted = await validateProject({ projectRoot: project, env: { HOME: home } });
  assert.equal(
    accepted.diagnostics.some(({ code }) => code === "PROVIDER_HOME_UNSAFE"),
    false,
    JSON.stringify(accepted.diagnostics)
  );
});

// The prediction duplicates the adapters' rules, so check it against the adapter code itself.
test(
  "predictedProviderHome matches the generated adapters' resolveProviderHome",
  { skip: spawnSync("bun", ["--version"]).status === 0 ? false : "bun is not installed" },
  () => {
    const home = privateHome();
    const adapter = fileURLToPath(new URL("../../src/templates/smithers/agents/provider-home.tsx", import.meta.url));
    const cases: Array<{ agentRef: string; provider: string; configDir?: string; env?: Record<string, string> }> = [
      { agentRef: "CodexAgent", provider: "codex" },
      { agentRef: "ClaudeAgent", provider: "claude" },
      { agentRef: "KimiAgent", provider: "kimi" },
      { agentRef: "DeepSeekAgent", provider: "deepseek" },
      { agentRef: "ClaudeAgent", provider: "claude", configDir: "work/a" },
      { agentRef: "CodexAgent", provider: "codex", env: { CODEX_HOME: path.join(home, "codex-home") } },
      { agentRef: "CodexAgent", provider: "codex", env: { ULTRAFUZZ_PROVIDER_HOME_ROOT: path.join(home, "root") } }
    ];
    for (const { agentRef, provider, configDir, env = {} } of cases) {
      const launch = { HOME: home, ...env };
      const resolved = spawnSync(
        "bun",
        [
          "-e",
          `import { resolveProviderHome } from ${JSON.stringify(adapter)}; process.stdout.write(resolveProviderHome(${JSON.stringify(provider)}, ${JSON.stringify(configDir)}));`
        ],
        { encoding: "utf8", env: { PATH: process.env.PATH, ...launch } }
      );
      assert.equal(resolved.status, 0, resolved.stderr);
      const agents = configDir === undefined ? {} : { [agentRef]: { auth: "subscription" as const, configDir } };
      assert.equal(
        predictedProviderHome(agentRef, config(agents), launch),
        fs.realpathSync(resolved.stdout),
        `${agentRef} ${JSON.stringify({ configDir, env })}`
      );
    }
  }
);

// The adapters require the provider-home root itself to be private too, not only the home below it.
test("providerHomeProblems checks the provider-home root, and repeated fixes tighten root and home", () => {
  const home = privateHome();
  const root = path.join(home, ".ultrafuzz-provider-homes");
  const deepseek = path.join(root, "deepseek");
  fs.mkdirSync(deepseek, { recursive: true });
  fs.chmodSync(root, 0o755);
  fs.chmodSync(deepseek, 0o755);
  const problems = () => providerHomeProblems(["DeepSeekAgent"], config(), { HOME: home });

  assert.deepEqual(
    problems().map(({ directory, reason, fixable }) => [directory, reason, fixable]),
    [[root, "has mode 755", true]]
  );
  // As `doctor --fix` does: fix, then check again until nothing fixable is left.
  for (let pass = 0; pass < 3 && problems().length > 0; pass += 1) fixProviderHomes(problems());
  assert.deepEqual(problems(), []);
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(deepseek).mode & 0o777, 0o700);
});

test(
  "providerHomeProblems reports a relative provider-home root and an uninspectable directory",
  { skip: process.getuid?.() === 0 ? "root can search a mode-000 directory" : false },
  () => {
    const home = privateHome();
    assert.deepEqual(
      providerHomeProblems(["CodexAgent"], config(), { HOME: home, ULTRAFUZZ_PROVIDER_HOME_ROOT: "relative/root" }).map(
        ({ directory, fixable }) => [directory, fixable]
      ),
      [["relative/root", false]]
    );

    // A parent the operator cannot search hides the home; the adapter fails there, so does the check.
    const locked = path.join(home, "locked");
    fs.mkdirSync(path.join(locked, "codex"), { recursive: true });
    fs.chmodSync(locked, 0o000);
    try {
      const problems = providerHomeProblems(["CodexAgent"], config(), {
        HOME: home,
        CODEX_HOME: path.join(locked, "codex")
      });
      assert.equal(problems.length, 1, JSON.stringify(problems));
      assert.match(problems[0]?.reason ?? "", /could not be inspected \(EACCES\)/u);
      assert.equal(problems[0]?.fixable, false);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  }
);

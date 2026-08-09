import {
  cliOwnedSchemaRegistry,
  validateCliResultEnvelope,
  validateOperatorInput
} from "../dist/cli-schema-registry.js";

const registry = cliOwnedSchemaRegistry();
if (registry.length === 0) throw new Error("CLI schema registry is empty");

const invocationFailure = validateCliResultEnvelope({
  schema_version: "ultrafuzz.cli.result.v2",
  command: "schema-registry-build-check",
  ok: false,
  diagnostics: [],
  data: null
});
if (!invocationFailure.ok) {
  throw new Error(`CLI result schema build check failed: ${JSON.stringify(invocationFailure.issues)}`);
}

const operatorInput = validateOperatorInput({ nested: [null, true, 1, "value"] });
if (!operatorInput.ok) {
  throw new Error(`operator-input schema build check failed: ${JSON.stringify(operatorInput.issues)}`);
}

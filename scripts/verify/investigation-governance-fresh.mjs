import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { createVerifierCommands } from "../lib/verify-commands.mjs";
import { createOwnedMcpStdioTransport } from "../lib/owned-mcp-stdio.mjs";
import { closeVerifierResources } from "../lib/verifier-cleanup.mjs";
import { VerifierFixture } from "../lib/verifier-fixture.mjs";
import { importVerifierSource } from "../lib/verifier-source-loader.mjs";

const load = (path) => importVerifierSource(path, import.meta.url);
const { parseEvidence } = await load("../../src/domain/evidence.ts");
const root = await VerifierFixture.open({
  prefix: "rea-governance-roundtrip-",
  private: false,
});
const commands = await createVerifierCommands();
const environment = {
  ...process.env,
  REA_LOG_LEVEL: "silent",
  REA_MCP_TOOL_FAMILIES: "application,session",
};
delete environment.HOPPER_TARGET_PATH;
const loader = new URL("../lib/verifier-source-loader.mjs", import.meta.url)
  .href;
const boot = (source) =>
  'import { importVerifierSource as load } from "' + loader + '";\n' + source;
const cliBoot = boot(
  [
    'const { createCli, closeCliResources } = await load("../../src/cli.ts", "' +
      loader +
      '");',
    "try { await createCli(process.env).serve(process.argv.slice(1)); } finally { await closeCliResources(); }",
  ].join("\n"),
);
const mcpBoot = boot(
  'const { runEntrypoint } = await load("../../src/main.ts", "' +
    loader +
    '"); await runEntrypoint();',
);
const cli = async (name, document, ...args) => {
  const result = await commands.exec(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      cliBoot,
      "--",
      name,
      JSON.stringify(document),
      ...args,
      "--json",
    ],
    { env: environment, timeout: 45_000, maxBuffer: 2 * 1024 * 1024 },
  );
  return parseEvidence(JSON.parse(result.stdout));
};
const selection = (evidence_id) => ({ kind: "retained-evidence", evidence_id });
const snapshot = (name) => ({
  scope_id: "synthetic-settings",
  target_revision_id: "amber",
  sources: [],
  patch: {
    components: [],
    scenarios: [{ id: "layout", name }],
    variants: [],
    relations: [],
    claims: [
      {
        id: "save",
        subject: { kind: "scenario", id: "layout" },
        target_revision_id: "amber",
        variant_id: null,
        statement: "Fixture layout can be saved",
        confidence: "inferred",
        rationale: "Synthetic fixture",
        sources: [],
      },
    ],
    gaps: [],
    coverage: {
      status: "partial",
      limitations: ["No target execution in this check"],
    },
  },
});
let client;
let transport;
try {
  const firstPath = join(root.path, "first.json");
  const secondPath = join(root.path, "second.json");
  const originalPath = join(root.path, "original.json");
  const finalPath = join(root.path, "portable.json");
  const first = await cli(
    "update-investigation-graph",
    snapshot("Before"),
    "--evidence-output",
    firstPath,
  );
  const child = {
    ...snapshot("After"),
    previous: selection(first.evidence_id),
  };
  const second = await cli(
    "update-investigation-graph",
    child,
    "--evidence-bundle",
    firstPath,
    "--evidence-output",
    secondPath,
  );
  const decision = {
    revision_id: "r1",
    previous: null,
    mapping_evidence: selection(second.evidence_id),
    claim_id: "save",
    reason: { status: "unknown" },
    actor_claim: { status: "declared", value: "synthetic-reviewer" },
  };
  const original = await cli(
    "record-behavior-governance",
    {
      ...decision,
      kind: "source-system",
      scope_id: "synthetic-settings",
      disposition: "confirmed",
    },
    "--evidence-bundle",
    secondPath,
    "--evidence-output",
    originalPath,
  );
  const migrationRequest = {
    ...decision,
    kind: "migration",
    scope_id: "synthetic-upgrade",
    disposition: "preserve",
    origin_governance: selection(original.evidence_id),
  };
  const migration = await cli(
    "record-behavior-governance",
    migrationRequest,
    "--evidence-bundle",
    originalPath,
    "--evidence-output",
    finalPath,
  );
  const request = {
    source: selection(second.evidence_id),
    view: {
      kind: "investigation-graph",
      scenario_id: "layout",
      governance_evidence_ids: [original.evidence_id, migration.evidence_id],
    },
  };
  const cliView = await cli(
    "inspect-analysis-view",
    request,
    "--evidence-bundle",
    finalPath,
  );

  client = new Client({ name: "governance-portability", version: "1" });
  transport = await createOwnedMcpStdioTransport({
    command: process.execPath,
    arguments: ["--input-type=module", "--eval", mcpBoot],
    cwd: process.cwd(),
    hostEnvironment: environment,
    expectedCommand: null,
    sweepTokenOwnedProcesses: true,
  });
  await client.connect(transport);
  const toolNames = (await client.listTools()).tools.map(({ name }) => name);
  assert.ok(toolNames.includes("update_investigation_graph"));
  assert.ok(toolNames.includes("record_behavior_governance"));
  const call = (name, args) => client.callTool({ name, arguments: args });
  assert.equal((await call("inspect_analysis_view", request)).isError, true);
  assert.notEqual(
    (await call("import_evidence_bundle", { path: finalPath })).isError,
    true,
  );
  const replay = parseEvidence(
    (await call("record_behavior_governance", migrationRequest))
      .structuredContent,
  );
  assert.equal(replay.evidence_id, migration.evidence_id);
  const restored = parseEvidence(
    (await call("inspect_analysis_view", request)).structuredContent,
  );
  assert.equal(restored.evidence_id, cliView.evidence_id);
  assert.deepEqual(restored.normalized_result, cliView.normalized_result);
  assert.deepEqual(
    restored.normalized_result.governance.map(
      (item) => item.record.approval.status,
    ),
    ["pending", "pending"],
  );
  const prior = parseEvidence(
    (
      await call("inspect_analysis_view", {
        source: selection(first.evidence_id),
        view: { kind: "investigation-graph", scenario_id: "layout" },
      })
    ).structuredContent,
  );
  assert.equal(prior.normalized_result.scenario.name, "Before");
  const bytes = await readFile(finalPath);
  assert.ok(bytes.length > 0);
  console.log(
    JSON.stringify({
      cli_mcp_view_id: restored.evidence_id,
      predecessor_id: first.evidence_id,
      graph_id: second.evidence_id,
      governance_ids: request.view.governance_evidence_ids,
      bundle_bytes: bytes.length,
    }),
  );
} finally {
  await closeVerifierResources([
    () => client?.close(),
    () => transport?.close(),
    () => commands.close(),
  ]);
  await root.release();
}

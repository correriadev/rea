import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { BinarySession } from "../../../src/application/binary/BinarySession.js";
import { inspectAnalysisViewValidated } from "../../../src/application/analysisView/AnalysisViewService.js";
import { recordBehaviorGovernance } from "../../../src/application/investigation/BehaviorGovernanceService.js";
import { updateInvestigationGraph } from "../../../src/application/investigation/InvestigationGraphService.js";
import { InvestigationRecords } from "../../../src/application/investigation/InvestigationRecords.js";
import { readyReviewedLedgerRequest } from "../../../src/application/ReconstructionObligationLedger.fixture.js";
import { buildReconstructionObligationLedgerEvidence } from "../../../src/application/ReconstructionObligationLedgerService.js";
import { registerApplicationCommands } from "../../../src/cli/applicationCommands.js";
import { cliCommand } from "../../../src/cli/commandRegistry.js";
import type { CliInstance } from "../../../src/cli/types.js";
import {
  createEvidence,
  evidenceSchema,
} from "../../../src/domain/evidence.js";
import {
  createEvidenceBundle,
  parseEvidenceBundle,
} from "../../../src/domain/evidenceBundle.js";
import { unknownTarget } from "../../../src/domain/targetIdentity.js";
import { createLogger } from "../../../src/logger.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestProviderRouter } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const retained = (evidence_id: string) => ({
  kind: "retained-evidence" as const,
  evidence_id,
});

it("projects a reported verification failure separately from the pending migration disposition", () => {
  const records = new InvestigationRecords();
  const graph = updateInvestigationGraph(graphInput("Settings"), records);
  if (!graph.ok) throw graph.error;
  const mapping = graph.value.evidence;
  expect(records.recordEvidence(mapping).ok).toBe(true);
  const request = readyReviewedLedgerRequest();
  const reviewed = request.reviewed_obligations[0]!;
  const binding = request.manifest.bindings[0]!;
  const verifier = binding.verifier!;
  const ledger = buildReconstructionObligationLedgerEvidence({
    ...request,
    evidence_bundle: createEvidenceBundle([
      ...request.evidence_bundle.records,
      mapping,
    ]),
    reviewed_obligations: [
      {
        ...reviewed,
        review_evidence_ids: [
          ...reviewed.review_evidence_ids,
          mapping.evidence_id,
        ],
      },
    ],
    manifest: {
      contradictions: [],
      bindings: [{ ...binding, verifier: { ...verifier, status: "fail" } }],
    },
  });
  if (!ledger.ok) throw ledger.error;
  for (const source of [...request.evidence_bundle.records, ledger.value])
    expect(records.recordEvidence(source).ok).toBe(true);
  const migration = recordBehaviorGovernance(
    {
      kind: "migration",
      scope_id: "upgrade",
      revision_id: "r1",
      previous: null,
      mapping_evidence: retained(mapping.evidence_id),
      claim_id: "save-layout",
      disposition: "change-deliberately",
      reason: { status: "known", text: "Owner review pending" },
      actor_claim: { status: "declared", value: "fixture-owner" },
      verification: {
        ledger: retained(ledger.value.evidence_id),
        obligation_id: reviewed.obligation_id,
        obligation_version: reviewed.obligation_version,
      },
    },
    records,
  );
  if (!migration.ok) throw migration.error;
  expect(records.recordEvidence(migration.value.evidence).ok).toBe(true);
  const result = inspectAnalysisViewValidated(
    {
      source: retained(mapping.evidence_id),
      view: {
        kind: "investigation-graph",
        scenario_id: "layout",
        offset: 0,
        limit: 64,
        governance_evidence_ids: [migration.value.evidence.evidence_id],
      },
    },
    (id) => records.evidenceForAnalysis(id),
  );
  expect(result).toMatchObject({
    ok: true,
    value: {
      normalized_result: {
        governance: [
          {
            record: {
              disposition: "change-deliberately",
              approval: { status: "pending" },
            },
            verification: {
              status: "implemented",
              verifier_status: "fail",
              verifier_evidence_id: verifier.result_evidence_id,
            },
          },
        ],
      },
    },
  });
});

it("writes separate source and migration governance and restores both with the scenario", async () => {
  const instance = cli();
  const graph = cliCommand(instance, "update-investigation-graph");
  const governance = cliCommand(instance, "record-behavior-governance");
  expect(governance?.operations.map(({ name }) => name)).toEqual([
    "record_behavior_governance",
  ]);
  if (!governance || !graph) return;
  const root = await createTestTempDirectory("rea-governance-public-");
  const graphPath = join(root, "graph.json");
  const sourcePath = join(root, "source.json");
  const migrationPath = join(root, "migration.json");
  const run = async (
    command: typeof graph,
    input: unknown,
    output: string,
    bundle?: string,
  ) =>
    evidenceSchema.parse(
      await command.definition.run({
        args: { inputJson: JSON.stringify(input) },
        options: {
          evidenceOutput: output,
          ...(bundle === undefined ? {} : { evidenceBundle: bundle }),
        },
        formatExplicit: true,
      }),
    );
  const mapping = await run(graph, graphInput("Settings"), graphPath);
  const common = {
    revision_id: "r1",
    previous: null,
    mapping_evidence: retained(mapping.evidence_id),
    claim_id: "save-layout",
    reason: { status: "unknown" },
    actor_claim: { status: "declared", value: "fixture-owner" },
  };
  const original = await run(
    governance,
    {
      ...common,
      kind: "source-system",
      scope_id: "settings",
      disposition: "confirmed",
    },
    sourcePath,
    graphPath,
  );
  const migrationMessage = {
    ...common,
    kind: "migration",
    scope_id: "upgrade",
    disposition: "preserve",
    origin_governance: retained(original.evidence_id),
  };
  const migration = await run(
    governance,
    migrationMessage,
    migrationPath,
    sourcePath,
  );
  const bundle = parseEvidenceBundle(
    JSON.parse(await readFile(migrationPath, "utf8")),
  );
  expect(bundle.records.map(({ evidence_id }) => evidence_id).sort()).toEqual(
    [mapping.evidence_id, original.evidence_id, migration.evidence_id].sort(),
  );
  const { client } = await createApplicationMcpHarness({ session: session() });
  expect(
    (
      await client.callTool({
        name: "import_evidence_bundle",
        arguments: { path: migrationPath },
      })
    ).isError,
  ).not.toBe(true);
  const governance_evidence_ids = [original.evidence_id, migration.evidence_id];
  const request = view(mapping.evidence_id);
  const result = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      ...request,
      view: { ...request.view, governance_evidence_ids },
    },
  });
  expect(result.structuredContent).toMatchObject({
    evidence_links: [mapping.evidence_id, ...governance_evidence_ids],
    normalized_result: {
      scenario: { id: "layout" },
      governance: [
        {
          evidence_id: original.evidence_id,
          record: { kind: "source-system", approval: { status: "pending" } },
        },
        {
          evidence_id: migration.evidence_id,
          record: {
            kind: "migration",
            scope_id: "upgrade",
            disposition: "preserve",
            approval: { status: "pending" },
          },
        },
      ],
    },
  });
  expect(
    (
      await client.callTool({
        name: "record_behavior_governance",
        arguments: {
          ...migrationMessage,
          approval: { status: "approved" },
        },
      })
    ).isError,
  ).toBe(true);
});
const view = (id: string) => ({
  source: retained(id),
  view: { kind: "investigation-graph", scenario_id: "layout" },
});
const source = (operation: string) =>
  createEvidence(
    unknownTarget("not-observed"),
    { id: "fixture", name: "Fixture", version: "1" },
    { operation, parameters: {}, result: { operation }, confidence: "derived" },
  );
const graphPatch = (name: string) => ({
  components: [],
  scenarios: [{ id: "layout", name }],
  variants: [],
  relations: [],
  claims: [
    {
      id: "save-layout",
      subject: { kind: "scenario", id: "layout" },
      target_revision_id: "amber",
      variant_id: null,
      statement: "Save layout",
      confidence: "inferred",
      rationale: "Static fixture",
      sources: [],
    },
  ],
  gaps: [],
  coverage: { status: "partial", limitations: ["Synthetic fixture"] },
});
const graphInput = (name: string) => ({
  scope_id: "settings",
  target_revision_id: "amber",
  sources: [],
  patch: graphPatch(name),
});

const cli = (): CliInstance => {
  const instance: CliInstance = { name: "rea", serve: async () => {} };
  registerApplicationCommands(instance, createLogger("cli", "silent"));
  return instance;
};

const session = () =>
  new BinarySession(
    createTestProviderRouter(() => {
      throw new Error("Target-free workflow opened an analysis provider");
    }),
  );

it("publishes two CLI graph revisions and restores both in a new MCP session", async () => {
  const instance = cli();
  const command = cliCommand(instance, "update-investigation-graph");
  expect(command?.operations.map(({ name }) => name)).toEqual([
    "update_investigation_graph",
  ]);
  if (!command) return;
  const root = await createTestTempDirectory("rea-graph-public-");
  const firstPath = join(root, "first.json");
  const secondPath = join(root, "second.json");
  const originalSource = source("inspect_binary_layout");
  const first = await command.definition.run({
    args: {
      inputJson: JSON.stringify({
        ...graphInput("Before"),
        sources: [originalSource],
      }),
    },
    options: { evidenceOutput: firstPath },
    formatExplicit: true,
  });
  const firstEvidence = evidenceSchema.parse(first);
  const child = {
    ...graphInput("After"),
    previous: retained(firstEvidence.evidence_id),
  };
  const second = await command.definition.run({
    args: { inputJson: JSON.stringify(child) },
    options: { evidenceBundle: firstPath, evidenceOutput: secondPath },
    formatExplicit: true,
  });
  const secondEvidence = evidenceSchema.parse(second);
  const bundle = parseEvidenceBundle(
    JSON.parse(await readFile(secondPath, "utf8")),
  );
  expect(bundle.records.map(({ evidence_id }) => evidence_id).sort()).toEqual(
    [
      originalSource.evidence_id,
      firstEvidence.evidence_id,
      secondEvidence.evidence_id,
    ].sort(),
  );
  expect(
    bundle.records.find(
      ({ evidence_id }) => evidence_id === firstEvidence.evidence_id,
    ),
  ).toEqual(firstEvidence);
  const refusal = await command.definition.run({
    args: {
      inputJson: JSON.stringify({ ...child, patch: graphPatch("Refused") }),
    },
    options: { evidenceBundle: firstPath, evidenceOutput: secondPath },
    formatExplicit: true,
  });
  expect(evidenceSchema.safeParse(refusal).success).toBe(false);
  expect(
    parseEvidenceBundle(JSON.parse(await readFile(secondPath, "utf8"))),
  ).toEqual(bundle);

  const { client } = await createApplicationMcpHarness({ session: session() });
  expect((await client.listTools()).tools.map(({ name }) => name)).toContain(
    "update_investigation_graph",
  );
  expect(
    (
      await client.callTool({
        name: "inspect_analysis_view",
        arguments: view(firstEvidence.evidence_id),
      })
    ).isError,
  ).toBe(true);
  expect(
    (
      await client.callTool({
        name: "import_evidence_bundle",
        arguments: { path: secondPath },
      })
    ).isError,
  ).not.toBe(true);
  for (const [expected, name] of [
    [firstEvidence, "Before"],
    [secondEvidence, "After"],
  ] as const) {
    const result = await client.callTool({
      name: "inspect_analysis_view",
      arguments: view(expected.evidence_id),
    });
    expect(result.structuredContent).toMatchObject({
      normalized_result: {
        kind: "investigation-graph",
        parent_evidence_id: expected.evidence_id,
        scenario: { name },
      },
    });
  }
  const retry = await client.callTool({
    name: "update_investigation_graph",
    arguments: child,
  });
  expect(retry.structuredContent).toMatchObject({
    evidence_id: secondEvidence.evidence_id,
  });
});

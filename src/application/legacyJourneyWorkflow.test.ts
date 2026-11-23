import { constants } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { analysisViewJavaScriptEvidence } from "../../tests/fixtures/analysisView.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { createApplicationMcpHarness } from "../../tests/fixtures/applicationMcpHarness.js";
import { evidenceFileTarget, parseEvidence } from "../domain/evidence.js";
import {
  createEvidenceBundle,
  parseEvidenceBundle,
} from "../domain/evidenceBundle.js";
import { createHistoricalSourceGraph } from "../domain/referenceSourceGraph.js";
import { characterizeLegacyApplicationJourney } from "./legacyJourneyWorkflow.js";
import { inspectAnalysisView } from "./analysisView/AnalysisViewService.js";
import { EvidenceLedger } from "./investigation/EvidenceLedger.js";
import { legacyJourneyWorkflowResultSchema } from "../domain/legacyJourneyProject.js";
import { sha256Hex } from "../kernel/sha256Hex.js";

const parent = analysisViewJavaScriptEvidence();
const input = {
  build_evidence_id: parent.evidence_id,
  evidence_bundle: createEvidenceBundle([parent]),
  characterization: {
    source: {
      revision: null,
      inventory: createHistoricalSourceGraph({
        schema: "HistoricalSourceGraph",
        authority: "historical-reference",
        root_alias: "$REFERENCE_ROOT",
        inventory_state: "complete",
        entries: [],
        relationships: [],
        parse_failures: [],
        exclusions: [],
        languages: [],
        manifests: [],
        vcs: { kind: "none", head: null, dirty: null },
        provenance: { importer: "test", importer_version: "1", caller: "test" },
        limitations: [],
      }),
    },
    build: { artifact_sha256: evidenceFileTarget(parent)?.sha256 },
    choices: {},
    comparison: { state: "unavailable", reason: "No supported source mapping" },
  },
  view: {
    kind: "legacy-journey",
    journey_id: "settings",
    paths: [],
    observations: [],
  },
};

it("analyzes a local build and compares it to a portable source inventory through MCP", async () => {
  const root = await createTestTempDirectory("legacy-local-");
  const build = join(root, "build");
  const historicalTree = join(root, "historical");
  const inventoryPath = join(root, "reference.json");
  await mkdir(build);
  await mkdir(historicalTree);
  const source = Buffer.from("module.exports = { open: () => 'wide' };\n");
  await writeFile(join(historicalTree, "main.js"), source);
  await writeFile(join(build, "main.js"), source);
  await writeFile(
    join(build, "package.json"),
    JSON.stringify({ name: "legacy-fixture", main: "main.js" }),
  );
  const { root_sha256: _digest, ...referenceFields } =
    input.characterization.source.inventory;
  const inventory = createHistoricalSourceGraph({
    ...referenceFields,
    languages: ["JavaScript"],
    entries: [
      {
        path: "main.js",
        kind: "file",
        sha256: sha256Hex(source),
        size: source.length,
        language: "JavaScript",
        classifications: ["source"],
        content_state: "hashed",
        limitations: [],
      },
    ],
  });
  await writeFile(inventoryPath, JSON.stringify(inventory));
  const { client, session } = await createApplicationMcpHarness();
  const reply = await client.callTool({
    name: "characterize_legacy_application_journey",
    arguments: {
      local_inputs: {
        source: { kind: "inventory-file", path: inventoryPath },
        build: { input_path: build, format: "directory" },
      },
      view: input.view,
      feature_seeds: [
        { kind: "module", value: "main.js", match: "exact" },
        { kind: "channel", value: "prefs:missing", match: "exact" },
      ],
    },
  });
  expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
  const dossier = legacyJourneyWorkflowResultSchema.parse(
    parseEvidence(reply.structuredContent).normalized_result,
  );
  expect(dossier.source_comparison_evidence_id).not.toBeNull();
  const comparison = session.evidenceById(
    dossier.source_comparison_evidence_id!,
  );
  expect(comparison?.operation).toBe("compare_source_to_bundle");
  expect(comparison?.normalized_result).toMatchObject({
    reference: { root_sha256: inventory.root_sha256 },
    items: expect.arrayContaining([
      expect.objectContaining({ status: "unchanged" }),
    ]),
  });
  const journey = session.evidenceById(dossier.view_evidence_id);
  expect(journey?.normalized_result).toMatchObject({
    static_traces: [
      { seed: { value: "main.js" } },
      { seed: { value: "prefs:missing" }, coverage: "no-match" },
    ],
  });
  for (const id of journey?.evidence_links ?? [])
    expect(session.evidenceById(id)).toBeDefined();

  const direct = await client.callTool({
    name: "characterize_legacy_application_journey",
    arguments: {
      local_inputs: {
        source: { kind: "source-tree", root: historicalTree },
        build: { input_path: build, format: "directory" },
      },
      view: input.view,
    },
  });
  if (!constants.O_NOFOLLOW) {
    expect(direct.isError, JSON.stringify(direct)).not.toBe(true);
    const partial = legacyJourneyWorkflowResultSchema.parse(
      parseEvidence(direct.structuredContent).normalized_result,
    );
    expect(partial).toMatchObject({
      coverage: "partial",
      source_comparison_evidence_id: null,
      diagnostics: expect.arrayContaining([
        expect.stringContaining("Safe no-follow file opens are unavailable"),
      ]),
    });
    expect(session.evidenceById(partial.view_evidence_id)).toBeDefined();
  } else {
    expect(direct.isError, JSON.stringify(direct)).not.toBe(true);
    const graph = legacyJourneyWorkflowResultSchema.parse(
      parseEvidence(direct.structuredContent).normalized_result,
    );
    expect(
      session.evidenceById(graph.source_comparison_evidence_id!)
        ?.normalized_result,
    ).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ status: "unchanged" }),
      ]),
    });
  }
});
const settledReceiptFixture = async () => {
  const initial = await characterizeLegacyApplicationJourney(input);
  if (!initial.ok) throw initial.error;
  const ledger = initial.value.sources.find(
    ({ operation }) => operation === "build_reconstruction_obligation_ledger",
  );
  const { obligations } = (
    await import("../domain/reconstructionObligationLedgerSchemas.js")
  ).reconstructionObligationLedgerSchema.parse(ledger?.normalized_result);
  const baseline = input.characterization.build.artifact_sha256!;
  const candidate = "c".repeat(64);
  const absent = { kind: "absent-file" };
  const file = {
    kind: "file",
    relative_path: "preferences.json",
    sha256: "d".repeat(64),
    identity: "file-1",
    selected_value: { kind: "value", value: "compact" },
  };
  const phase = (
    index: number,
    build: string,
    profile: string,
    action: string,
    value: string,
    before = absent,
    after = absent,
  ) => ({
    action,
    build_sha256: build,
    profile,
    profile_identity: profile,
    process_identity: String(index),
    value,
    before,
    after,
  });
  const phases = [
    phase(0, baseline, "/old", "read-first", "wide"),
    phase(1, candidate, "/new", "read-first", "wide"),
    {
      ...phase(2, baseline, "/old", "seed", "compact", absent, file),
      handler_reply: "accepted",
    },
    phase(3, candidate, "/new", "seed", "compact", absent, file),
    phase(4, baseline, "/old", "read-first", "compact", file, file),
    phase(5, candidate, "/new", "read-first", "compact", file, file),
    phase(6, candidate, "/old", "read-first", "compact", file, file),
  ];
  const plan = [
    { family: "legacy-clean-start", phases: [0, 1] },
    { family: "legacy-same-build-restart", phases: [2, 4, 3, 5] },
    { family: "legacy-in-place-upgrade", phases: [2, 4, 6] },
  ];
  return {
    version: 1,
    journey_id: "settings",
    build_sha256: baseline,
    candidate_sha256: candidate,
    seed: "compact",
    cleanup: "complete",
    residual_profile_root: null,
    phases,
    cases: plan.map((item) => {
      const obligation = obligations.find(
        ({ family }) => family === item.family,
      )!;
      return {
        ...item,
        status: "pass",
        obligation_id: obligation.obligation_id,
        obligation_version: obligation.obligation_version,
      };
    }),
  };
};

it("closes only obligations with the correct settled runner receipt", async () => {
  const receipt = await settledReceiptFixture();
  const candidate = receipt.candidate_sha256;
  const output = join(
    await createTestTempDirectory("legacy-verified-"),
    "dossier",
  );
  const verified = await characterizeLegacyApplicationJourney({
    ...input,
    export_directory: output,
    verification: { candidate_sha256: candidate, receipt },
  });
  if (!verified.ok) throw verified.error;
  const result = legacyJourneyWorkflowResultSchema.parse(
    verified.value.evidence.normalized_result,
  );
  expect(result.verification_evidence_id).not.toBeNull();
  const archived = new EvidenceLedger();
  expect(
    archived.import(
      parseEvidenceBundle(
        JSON.parse(await readFile(join(output, "evidence.json"), "utf8")),
      ),
    ).ok,
  ).toBe(true);
  const query = JSON.parse(
    await readFile(join(output, "journey-query.json"), "utf8"),
  );
  const restored = await inspectAnalysisView(query, (id) =>
    archived.forAnalysis(id),
  );
  if (!restored.ok) throw restored.error;
  expect(restored.value.evidence_id).toBe(result.view_evidence_id);
  expect(restored.value.normalized_result).toMatchObject({
    verification: {
      evidence_id: result.verification_evidence_id,
      phases: expect.arrayContaining([
        expect.objectContaining({
          index: 2,
          requested: expect.objectContaining({
            kind: "value",
            value: "compact",
          }),
          reply: expect.objectContaining({
            kind: "value",
            value: "accepted",
          }),
          stored: expect.objectContaining({
            selected_value: { kind: "value", value: "compact" },
          }),
          reopened: expect.objectContaining({ kind: "unknown" }),
        }),
        expect.objectContaining({
          index: 6,
          requested: expect.objectContaining({ kind: "unknown" }),
          reply: expect.objectContaining({ kind: "unknown" }),
          reopened: expect.objectContaining({
            kind: "value",
            value: "compact",
          }),
        }),
      ]),
    },
  });
  const mismatched = await inspectAnalysisView(
    {
      ...query,
      view: { ...query.view, journey_id: "different" },
    },
    (id) => archived.forAnalysis(id),
  );
  if (!mismatched.ok) throw mismatched.error;
  expect(mismatched.value.normalized_result).not.toHaveProperty("verification");
  expect(result.obligations.map(({ status }) => status)).toEqual([
    "verified",
    "verified",
    "verified",
  ]);
  const rejected = await characterizeLegacyApplicationJourney({
    ...input,
    verification: { candidate_sha256: "a".repeat(64), receipt },
  });
  expect(rejected).toMatchObject({ ok: false });
  const receiptPath = join(
    await createTestTempDirectory("legacy-receipt-"),
    "result.json",
  );
  await writeFile(receiptPath, JSON.stringify(receipt));
  const fromFile = await characterizeLegacyApplicationJourney({
    ...input,
    verification: { candidate_sha256: candidate, receipt_path: receiptPath },
  });
  if (!fromFile.ok) throw fromFile.error;
  const restoredResult = legacyJourneyWorkflowResultSchema.parse(
    fromFile.value.evidence.normalized_result,
  );
  expect(restoredResult.verification_evidence_id).toBe(
    result.verification_evidence_id,
  );
  expect(restoredResult.view_evidence_id).toBe(result.view_evidence_id);
  const portableRequest = {
    dossier_manifest_path: join(output, "manifest.json"),
    verification: { candidate_sha256: candidate, receipt_path: receiptPath },
  };
  const resumed = await characterizeLegacyApplicationJourney(portableRequest);
  if (!resumed.ok) throw resumed.error;
  expect(resumed.value.evidence.normalized_result).toMatchObject({
    dossier_sha256: result.dossier_sha256,
    verification_evidence_id: result.verification_evidence_id,
    view_evidence_id: result.view_evidence_id,
  });
  await writeFile(
    join(output, "journey-query.json"),
    JSON.stringify({
      ...query,
      view: { ...query.view, journey_id: "uncommitted" },
    }),
  );
  expect(
    await characterizeLegacyApplicationJourney(portableRequest),
  ).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisInputError",
      userMessage: expect.stringContaining("committed view"),
    },
  });
});
it("executes the named workflow through the MCP SDK and retains its linked view", async () => {
  const { client, session } = await createApplicationMcpHarness();
  const file = join(
    await createTestTempDirectory("legacy-bundle-"),
    "evidence.json",
  );
  const { evidence_bundle, ...request } = input;
  await writeFile(file, JSON.stringify(evidence_bundle));
  const reply = await client.callTool({
    name: "characterize_legacy_application_journey",
    arguments: { ...request, evidence_bundle_path: file },
  });
  expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
  const result = legacyJourneyWorkflowResultSchema.parse(
    parseEvidence(reply.structuredContent).normalized_result,
  );
  expect(result.obligations).toHaveLength(3);
  const direct = await characterizeLegacyApplicationJourney(input);
  if (!direct.ok) throw direct.error;
  expect(result).toEqual(direct.value.evidence.normalized_result);
  expect(session.evidenceById(result.view_evidence_id)).toBeDefined();
});
it("returns the same dossier identity with and without publication and retains both linked records", async () => {
  const inspected = await characterizeLegacyApplicationJourney(input);
  if (!inspected.ok) throw inspected.error;
  const summary = legacyJourneyWorkflowResultSchema.parse(
    inspected.value.evidence.normalized_result,
  );
  expect(summary.export).toBeNull();
  expect(summary.coverage).toBe("partial");
  expect(summary.obligations).toHaveLength(3);
  const restored = new EvidenceLedger();
  for (const item of inspected.value.sources)
    expect(restored.record(item).ok).toBe(true);
  expect(restored.forAnalysis(summary.view_evidence_id)).toBeDefined();
  expect(restored.forAnalysis(summary.ledger_evidence_id)).toBeDefined();

  const destination = join(
    await createTestTempDirectory("legacy-workflow-"),
    "project",
  );
  const published = await characterizeLegacyApplicationJourney({
    ...input,
    export_directory: destination,
  });
  if (!published.ok) throw published.error;
  const result = legacyJourneyWorkflowResultSchema.parse(
    published.value.evidence.normalized_result,
  );
  expect(result.dossier_sha256).toBe(summary.dossier_sha256);
  expect(await readFile(join(destination, "manifest.json"), "utf8")).toContain(
    '"bundle": "evidence.json"',
  );
  const portable = new EvidenceLedger();
  const archive = JSON.parse(
    await readFile(join(destination, "evidence.json"), "utf8"),
  );
  expect(portable.import(parseEvidenceBundle(archive)).ok).toBe(true);
  const query = JSON.parse(
    await readFile(join(destination, "journey-query.json"), "utf8"),
  );
  const projected = await inspectAnalysisView(query, (id) =>
    portable.forAnalysis(id),
  );
  if (!projected.ok) throw projected.error;
  expect(projected.value.evidence_id).toBe(summary.view_evidence_id);
});

it("refuses an unrelated build Evidence selection", async () => {
  const result = await characterizeLegacyApplicationJourney({
    ...input,
    characterization: {
      ...input.characterization,
      build: { artifact_sha256: "0".repeat(64) },
    },
  });
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
});

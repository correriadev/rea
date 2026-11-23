import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { analysisViewJavaScriptEvidence } from "../../tests/fixtures/analysisView.js";
import { analysisViewResultSchema } from "../domain/analysisView/analysisViewResult.js";
import { evidenceFileTarget } from "../domain/evidence.js";
import { createHistoricalSourceGraph } from "../domain/referenceSourceGraph.js";
import { inspectAnalysisView } from "./analysisView/AnalysisViewService.js";
import { characterizeLegacyJourney } from "./javascript/legacyCharacterization.js";
import {
  planLegacyJourneyProject,
  writeLegacyJourneyProject,
} from "./legacyJourneyExport.js";
import { ArtifactResourceScope, SafeOutputTree } from "../resources/index.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { build, request } from "./ReconstructionObligationLedger.fixture.js";

const projectFixture = async () => {
  const parent = analysisViewJavaScriptEvidence();
  const projected = await inspectAnalysisView(
    {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: {
        kind: "legacy-journey",
        journey_id: "<settings>",
        observations: [],
        paths: [],
      },
    },
    (id) => (id === parent.evidence_id ? parent : undefined),
  );
  if (!projected.ok) throw projected.error;
  const journey = analysisViewResultSchema.parse(
    projected.value.normalized_result,
  );
  if (journey.kind !== "legacy-journey") throw new Error("Unexpected view");
  const input = request([parent, projected.value]);
  const characterized = characterizeLegacyJourney({
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
        provenance: {
          importer: "test",
          importer_version: "1",
          caller: "test",
        },
        limitations: [],
      }),
    },
    build: { artifact_sha256: evidenceFileTarget(parent)?.sha256 },
    choices: {},
    comparison: {
      state: "unavailable",
      reason: "No source mapping provided",
    },
  });
  if (!characterized.ok) throw characterized.error;
  return {
    manifest: characterized.value,
    journey,
    evidence: input.evidence_bundle,
    ledger: build(input),
  };
};

describe("legacy journey export", () => {
  it("renders the open obligations with portable references and refuses a missing parent", async () => {
    const project = await projectFixture();
    const plan = planLegacyJourneyProject(project);
    if (!plan.ok) throw plan.error;
    const files = new Map(
      plan.value.map(({ path, content }) => [path, content]),
    );
    expect(planLegacyJourneyProject(project)).toEqual(plan);
    expect(files.get("manifest.json")).toContain('"journey": "journey.json"');
    expect(files.get("report.html")).toContain("&lt;settings&gt;");
    expect(files.get("migration-matrix.csv")).toContain(
      "legacy-in-place-upgrade",
    );
    expect(files.get("migration-matrix.csv")).not.toContain('"verified"');
    expect(
      planLegacyJourneyProject({
        ...project,
        evidence: { ...project.evidence, records: [] },
      }).ok,
    ).toBe(false);
  });

  it("publishes a complete dossier and refuses a second writer without changing the files", async () => {
    const project = await projectFixture();
    const destination = join(
      await createTestTempDirectory("legacy-journey-"),
      "dossier",
    );
    const resources = new ArtifactResourceScope();
    const completed = await writeLegacyJourneyProject(
      project,
      destination,
      resources,
    );
    expect(completed.files.map(({ path }) => path).at(-1)).toBe(
      "manifest.json",
    );
    const manifest = await readFile(join(destination, "manifest.json"), "utf8");
    await expect(
      writeLegacyJourneyProject(project, destination, resources),
    ).rejects.toMatchObject({
      _tag: "AnalysisInputError",
    });
    expect(await readFile(join(destination, "manifest.json"), "utf8")).toBe(
      manifest,
    );
  });

  it("rolls back an owned partial tree when a write fails", async () => {
    const project = await projectFixture();
    const destination = join(
      await createTestTempDirectory("legacy-journey-"),
      "incomplete",
    );
    const resources = new ArtifactResourceScope();
    const write = SafeOutputTree.prototype.write;
    const injected = vi
      .spyOn(SafeOutputTree.prototype, "write")
      .mockImplementation(function (
        this: SafeOutputTree,
        ...args: Parameters<typeof write>
      ) {
        if (args[0] === "report.html")
          throw new Error("Injected write failure");
        return write.apply(this, args);
      });
    try {
      await expect(
        writeLegacyJourneyProject(project, destination, resources),
      ).rejects.toThrow("Injected write failure");
      await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
      expect(resources.hasPending).toBe(false);
    } finally {
      injected.mockRestore();
    }
  });
});

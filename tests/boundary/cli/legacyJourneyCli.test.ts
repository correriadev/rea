import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { legacyJourneyWorkflowResultSchema } from "../../../src/domain/legacyJourneyProject.js";
import { createHistoricalSourceGraph } from "../../../src/domain/referenceSourceGraph.js";
import { sha256Hex } from "../../../src/kernel/sha256Hex.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "characterizes a local build, exports its trace, and exits",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-legacy-cli-");
    const artifact = join(root, "artifact");
    const output = join(root, "dossier");
    const source = Buffer.from("module.exports = { open: () => 'wide' };\n");
    await mkdir(artifact);
    await writeFile(join(artifact, "main.js"), source);
    const historical = createHistoricalSourceGraph({
      schema: "HistoricalSourceGraph",
      authority: "historical-reference",
      root_alias: "$REFERENCE_ROOT",
      inventory_state: "complete",
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
      relationships: [],
      parse_failures: [],
      exclusions: [],
      languages: ["JavaScript"],
      manifests: [],
      vcs: null,
      provenance: { importer: "test", importer_version: "1", caller: "test" },
      limitations: [],
    });
    const historicalFile = join(root, "source.json");
    await writeFile(historicalFile, JSON.stringify(historical));
    const document = join(root, "request.json");
    await writeFile(
      document,
      JSON.stringify({
        local_inputs: {
          source: { kind: "inventory-file", path: historicalFile },
          build: { input_path: artifact, format: "directory" },
        },
        feature_seeds: [{ kind: "module", value: "main.js", match: "exact" }],
        view: {
          kind: "legacy-journey",
          journey_id: "file",
          observations: [],
          paths: [],
        },
        export_directory: output,
      }),
    );
    const executed = await cli.run({
      freshProcess: true,
      timeoutMs: 15_000,
      arguments: [
        "characterize-legacy-application-journey",
        document,
        "--json",
      ],
    });
    expect(executed.exitCode).toBe(0);
    const dossier = legacyJourneyWorkflowResultSchema.parse(
      parseEvidence(executed.json).normalized_result,
    );
    expect(dossier.source_comparison_evidence_id).not.toBeNull();
    const query = JSON.parse(
      await readFile(join(output, "journey-query.json"), "utf8"),
    );
    expect(query.view.trace_evidence_ids).toHaveLength(1);
  },
);

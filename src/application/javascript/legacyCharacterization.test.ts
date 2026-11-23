import { describe, expect, it } from "vitest";
import { createHistoricalSourceGraph } from "../../domain/referenceSourceGraph.js";
import { characterizeLegacyJourney } from "./legacyCharacterization.js";

const inventory = createHistoricalSourceGraph({
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
});
const digest = "1".repeat(64);
const input = {
  source: { inventory, revision: "rev-1" },
  build: { artifact_sha256: digest },
  choices: { entry: "main.js" },
  comparison: {
    state: "unavailable",
    reason: "provider does not support mapping",
  },
};

describe("legacy characterization", () => {
  it("retains independent identities and unavailable correspondence through serialization", () => {
    const result = characterizeLegacyJourney(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(JSON.stringify(result.value))).toMatchObject({
      version: 1,
      coverage: "partial",
      source: input.source,
      build: input.build,
      choices: input.choices,
      correspondence: {
        matched: [],
        partial: [],
        unknown: [{ reason: input.comparison.reason }],
      },
    });
  });
});

it("links only the build whose digest was compared and preserves the comparison", async () => {
  const { compareSourceToBundle } =
    await import("../../domain/javascript/sourceToBundleComparison.js");
  const { createJavaScriptApplicationGraph, createJavaScriptApplicationNode } =
    await import("../../domain/javascript/javascriptApplicationGraph.js");
  const { artifactEvidence } =
    await import("../../domain/javascript/javascriptApplicationGraph.fixture.js");
  const sourceDigest = "2".repeat(64);
  const source = createHistoricalSourceGraph({
    schema: "HistoricalSourceGraph",
    authority: "historical-reference",
    root_alias: "$REFERENCE_ROOT",
    inventory_state: "complete",
    entries: [
      {
        path: "main.js",
        kind: "file",
        sha256: sourceDigest,
        size: 10,
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
    vcs: { kind: "none", head: null, dirty: null },
    provenance: { importer: "test", importer_version: "1", caller: "test" },
    limitations: [],
  });
  const node = createJavaScriptApplicationNode({
    kind: "artifact",
    identity: {
      strategy: "content-digest",
      stability: "global-exact",
      sha256: sourceDigest,
    },
    observations: [
      {
        label: "main.js",
        properties: { path: "main.js", file_kind: "javascript" },
        evidence: artifactEvidence(sourceDigest, "main.js"),
      },
    ],
  });
  const result = compareSourceToBundle({
    reference: source,
    application: {
      evidenceId: `ev_${"a".repeat(64)}`,
      rootArtifactSha256: digest,
      graph: createJavaScriptApplicationGraph({
        schema: "JavaScriptApplicationGraph",
        root_node_ids: [node.node_id],
        nodes: [node],
        edges: [],
        coverage: {
          status: "complete",
          truncated: false,
          omitted_count: 0,
          limits: [],
        },
        limitations: [],
      }),
    },
  });
  const request = {
    ...input,
    source: { inventory: source, revision: "rev-1" },
    comparison: { state: "available", result },
  };
  const matched = characterizeLegacyJourney(request);
  expect(matched.ok).toBe(true);
  if (!matched.ok) return;
  expect(matched.value.correspondence.matched).toEqual(result.items);
  expect(matched.value.comparison).toEqual(request.comparison);
  const otherBuild = characterizeLegacyJourney({
    ...request,
    build: { artifact_sha256: "3".repeat(64) },
  });
  expect(otherBuild.ok).toBe(false);
  if (!otherBuild.ok) expect(otherBuild.error._tag).toBe("AnalysisInputError");
});

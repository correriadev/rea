import { expect, it } from "vitest";
import { createEvidence } from "./evidence.js";
import { unknownTarget } from "./targetIdentity.js";
import {
  investigationGraphSchema,
  parseInvestigationGraphUpdate,
} from "./investigationGraph.js";

const evidence = createEvidence(
  unknownTarget("not-observed"),
  { id: "test", name: "Test", version: "1" },
  { operation: "inspect", parameters: {}, result: { answer: 42 } },
);
const reference = {
  kind: "retained-evidence" as const,
  evidence_id: evidence.evidence_id,
};
const patch = {
  components: [{ id: "component", name: "Component" }],
  scenarios: [
    { id: "scenario", name: "Scenario" },
    { id: "other", name: "Other" },
  ],
  variants: [
    { id: "variant", scenario_id: "scenario", name: "Variant", conditions: [] },
  ],
  relations: [
    {
      id: "edge",
      from: { kind: "scenario", id: "scenario" },
      to: { kind: "component", id: "component" },
      type: "uses",
    },
  ],
  claims: [
    {
      id: "claim",
      subject: { kind: "scenario", id: "scenario" },
      target_revision_id: "rev1",
      variant_id: "variant",
      statement: "Observed",
      confidence: "observed",
      rationale: null,
      sources: [
        {
          evidence_id: evidence.evidence_id,
          role: "supporting",
          target_revision_id: "rev1",
          identity_evidence_id: evidence.evidence_id,
        },
      ],
    },
  ],
  gaps: [
    {
      id: "gap",
      subject: { kind: "scenario", id: "scenario" },
      question: "What remains?",
      unknown: null,
      migration_checks: [],
    },
  ],
  coverage: { status: "partial", limitations: ["Not all paths examined"] },
};
const update = {
  scope_id: "scope",
  target_revision_id: "rev1",
  sources: [evidence, reference],
  patch,
};
const graph = {
  format_version: 1,
  scope_id: "scope",
  target_revision_id: "rev1",
  previous_evidence_id: null,
  source_evidence_ids: [evidence.evidence_id],
  ...patch,
  claims: patch.claims.map((item) => ({ ...item, applicability: "supported" })),
};

it("admits partial seeds, both Evidence input shapes, and explicit unknown coverage", () => {
  expect(parseInvestigationGraphUpdate(update).ok).toBe(true);
  expect(
    parseInvestigationGraphUpdate({
      ...update,
      sources: [],
      patch: {
        ...patch,
        claims: [],
        coverage: { status: "unknown", limitations: [] },
      },
    }).ok,
  ).toBe(true);
  expect(investigationGraphSchema.parse(graph)).toEqual(graph);
  expect(parseInvestigationGraphUpdate({ ...update, previous: null }).ok).toBe(
    false,
  );
  expect(parseInvestigationGraphUpdate({ ...update, scope_id: "" }).ok).toBe(
    false,
  );
  expect(
    parseInvestigationGraphUpdate({ ...update, previous: reference }).ok,
  ).toBe(true);
  const duplicate = parseInvestigationGraphUpdate({
    ...update,
    patch: { ...patch, components: [...patch.components, patch.components[0]] },
  });
  expect(duplicate.ok).toBe(false);
  if (!duplicate.ok)
    expect(duplicate.error.issues[0]?.path).toEqual([
      "patch",
      "components",
      1,
      "id",
    ]);
});

it("rejects duplicate IDs, malformed endpoints, and variants in another scenario", () => {
  const cases = [
    { ...graph, components: [...graph.components, graph.components[0]] },
    {
      ...graph,
      relations: [
        { ...graph.relations[0], to: { kind: "component", id: "missing" } },
      ],
    },
    {
      ...graph,
      relations: [
        { ...graph.relations[0], from: { kind: "bad", id: "scenario" } },
      ],
    },
    {
      ...graph,
      claims: [
        { ...graph.claims[0], subject: { kind: "scenario", id: "other" } },
      ],
    },
    { ...graph, source_evidence_ids: [] },
    { ...graph, variants: [{ ...graph.variants[0], scenario_id: "missing" }] },
    {
      ...graph,
      claims: [
        {
          ...graph.claims[0],
          sources: [{ ...graph.claims[0]?.sources[0], role: "unknown" }],
        },
      ],
    },
  ];
  for (const candidate of cases) {
    const parsed = investigationGraphSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(parsed.error.issues[0]?.path.length).toBeGreaterThan(0);
  }
});

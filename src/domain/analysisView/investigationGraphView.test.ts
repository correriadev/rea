import { expect, it } from "vitest";
import { projectAnalysisView } from "./analysisView.js";
import { analysisViewRequestSchema } from "./analysisViewRequest.js";
import type { AnalysisViewParent } from "./analysisViewParent.js";

const evidence = (letter: string) => `ev_${letter.repeat(64)}`;
const binding = (
  letter: string,
  role: "supporting" | "contradicting",
  revision: string | null,
) => ({
  evidence_id: evidence(letter),
  role,
  target_revision_id: revision,
  identity_evidence_id: revision === null ? null : evidence("a"),
});
const graph = {
  format_version: 1,
  scope_id: "scope",
  target_revision_id: "r2",
  previous_evidence_id: null,
  source_evidence_ids: [evidence("a"), evidence("b"), evidence("c")],
  components: [{ id: "client", name: "Client" }],
  scenarios: [
    { id: "login", name: "Login" },
    { id: "other", name: "Other" },
  ],
  variants: [
    {
      id: "mobile",
      scenario_id: "login",
      name: "Mobile",
      conditions: ["mobile client"],
    },
    {
      id: "web",
      scenario_id: "login",
      name: "Web",
      conditions: ["web client"],
    },
    { id: "unrelated", scenario_id: "other", name: "Other", conditions: [] },
  ],
  relations: [],
  claims: [
    {
      id: "client-claim",
      subject: { kind: "component", id: "client" },
      target_revision_id: "r2",
      variant_id: "web",
      statement: "The client performs login",
      confidence: "observed",
      rationale: null,
      sources: [binding("a", "supporting", "r2")],
      applicability: "supported",
    },
    {
      id: "old",
      subject: { kind: "variant", id: "web" },
      target_revision_id: "r1",
      variant_id: "web",
      statement: "Old flow",
      confidence: "observed",
      rationale: null,
      sources: [binding("a", "supporting", "r1")],
      applicability: "supported",
    },
    {
      id: "current",
      subject: { kind: "variant", id: "web" },
      target_revision_id: "r2",
      variant_id: "web",
      statement: "New flow",
      confidence: "derived",
      rationale: null,
      sources: [
        binding("a", "supporting", "r2"),
        binding("b", "contradicting", "r2"),
      ],
      applicability: "supported",
    },
    {
      id: "stable",
      subject: { kind: "variant", id: "mobile" },
      target_revision_id: "r2",
      variant_id: "mobile",
      statement: "Stable flow",
      confidence: "observed",
      rationale: null,
      sources: [binding("c", "supporting", "r2")],
      applicability: "supported",
    },
    {
      id: "uncertain",
      subject: { kind: "scenario", id: "login" },
      target_revision_id: "r2",
      variant_id: "mobile",
      statement: "Unverified flow",
      confidence: "inferred",
      rationale: "Needs binding",
      sources: [binding("b", "supporting", null)],
      applicability: "unresolved",
    },
  ],
  gaps: [
    {
      id: "gap",
      subject: { kind: "variant", id: "web" },
      question: "Can the client migrate?",
      unknown: {
        unknown_id: `unk_${"d".repeat(64)}`,
        revision: 1,
        revision_digest: "e".repeat(64),
      },
      migration_checks: [
        {
          action: "Probe web login",
          variant_id: "web",
          required_evidence: "response trace",
          required_authority: "controlled-replay",
        },
      ],
    },
  ],
  coverage: {
    status: "partial",
    limitations: ["Mobile observation is incomplete"],
  },
};
const parent: AnalysisViewParent = {
  operation: "update_investigation_graph",
  predicateType: "rea.investigation-graph",
  evidenceId: evidence("f"),
  normalizedResult: graph,
  limitations: ["Source caveat"],
};
const query = (offset = 0, limit = 64, target_revision_id?: string) =>
  projectAnalysisView(
    parent,
    analysisViewRequestSchema.parse({
      kind: "investigation-graph",
      scenario_id: "login",
      offset,
      limit,
      ...(target_revision_id === undefined ? {} : { target_revision_id }),
    }),
  );

it("projects a selected scenario with revision-aware claims, gaps and stable bounded pages", () => {
  const all = query();
  expect(all.ok).toBe(true);
  if (!all.ok || all.value.kind !== "investigation-graph")
    throw new Error("missing graph view");
  expect(all.value).toMatchObject({
    parent_evidence_id: parent.evidenceId,
    scenario: { id: "login" },
    target_revision_id: "r2",
    source_coverage: { status: "partial" },
    limitations: expect.arrayContaining([
      "Mobile observation is incomplete",
      "Source caveat",
    ]),
  });
  expect(all.value.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "component",
        value: { id: "client", name: "Client" },
      }),
      expect.objectContaining({
        kind: "claim",
        value: expect.objectContaining({
          id: "client-claim",
          variant_id: "web",
        }),
      }),
      expect.objectContaining({
        kind: "variant",
        value: expect.objectContaining({
          id: "web",
          conditions: ["web client"],
        }),
      }),
      expect.objectContaining({
        kind: "claim",
        revision_applicability: "other-revision",
        value: expect.objectContaining({ id: "old" }),
      }),
      expect.objectContaining({
        kind: "claim",
        revision_applicability: "current",
        value: expect.objectContaining({
          id: "current",
          confidence: "derived",
          sources: expect.arrayContaining([
            expect.objectContaining({
              evidence_id: evidence("a"),
              role: "supporting",
            }),
            expect.objectContaining({
              evidence_id: evidence("b"),
              role: "contradicting",
            }),
          ]),
        }),
      }),
      expect.objectContaining({
        kind: "claim",
        revision_applicability: "unresolved",
        value: expect.objectContaining({
          id: "uncertain",
          applicability: "unresolved",
        }),
      }),
      expect.objectContaining({
        kind: "gap",
        value: expect.objectContaining({
          id: "gap",
          unknown: expect.objectContaining({ revision: 1 }),
          migration_checks: [
            expect.objectContaining({
              action: "Probe web login",
              variant_id: "web",
            }),
          ],
        }),
      }),
    ]),
  );
  const previous = query(0, 64, "r1");
  expect(
    previous.ok &&
      previous.value.kind === "investigation-graph" &&
      previous.value.items,
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "claim",
        revision_applicability: "current",
        value: expect.objectContaining({ id: "old" }),
      }),
      expect.objectContaining({
        kind: "claim",
        revision_applicability: "other-revision",
        value: expect.objectContaining({ id: "current" }),
      }),
    ]),
  );
  const pages: typeof all.value.items = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = query(offset, 2);
    if (!page.ok || page.value.kind !== "investigation-graph")
      throw new Error("missing page");
    pages.push(...page.value.items);
    expect(page.value.source_coverage.status).toBe("partial");
    expect(page.value.coverage.total).toBe(all.value.coverage.total);
    offset = page.value.coverage.next_offset;
  }
  expect(pages).toEqual(all.value.items);
  expect(query()).toEqual(all);
});

it("rejects missing selections, incompatible sources and oversized pages", () => {
  const missing = projectAnalysisView(
    parent,
    analysisViewRequestSchema.parse({
      kind: "investigation-graph",
      scenario_id: "absent",
    }),
  );
  expect(missing).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
  expect(
    projectAnalysisView(
      { ...parent, predicateType: "rea.analysis" },
      analysisViewRequestSchema.parse({
        kind: "investigation-graph",
        scenario_id: "login",
      }),
    ),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
  expect(
    projectAnalysisView(
      { ...parent, normalizedResult: { ...graph, format_version: 2 } },
      analysisViewRequestSchema.parse({
        kind: "investigation-graph",
        scenario_id: "login",
      }),
    ),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
  expect(
    projectAnalysisView(
      { ...parent, operation: "unsupported_operation" },
      analysisViewRequestSchema.parse({
        kind: "investigation-graph",
        scenario_id: "login",
      }),
    ),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisUnsupportedTargetError" },
  });
  const oversized = {
    ...graph,
    claims: graph.claims.map((claim) =>
      claim.id === "current"
        ? { ...claim, statement: "x".repeat(1024 * 1024) }
        : claim,
    ),
  };
  expect(
    projectAnalysisView(
      { ...parent, normalizedResult: oversized },
      analysisViewRequestSchema.parse({
        kind: "investigation-graph",
        scenario_id: "login",
      }),
    ),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisResourceConstraintError" },
  });
});

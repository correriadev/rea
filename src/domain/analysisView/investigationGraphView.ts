import { z } from "zod";
import { behaviorGovernancePayloadSchema } from "../behaviorGovernance.js";
import { prefixedDigestSchema } from "../digests.js";
import {
  obligationStatusSchema,
  reconstructionObligationManifestBindingSchema,
} from "../reconstructionObligationLedgerSchemas.js";
import {
  investigationGraphSchema,
  type InvestigationGraph,
} from "../investigationGraph.js";
import { fixedCeilingConstraint } from "../analysisErrorCore.js";
import type { JsonValue } from "../jsonValue.js";
import { jsonValueByteLength } from "../jsonValueByteLength.js";
import { err, ok } from "../result.js";
import {
  createAnalysisViewResultReader,
  type AnalysisViewParent,
} from "./analysisViewParent.js";
import {
  boundedViewMessages,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import {
  INSPECT_ANALYSIS_VIEW_OPERATION,
  analysisViewInputError,
} from "./analysisViewErrors.js";
import { ownedView, type AdmittedView } from "./analysisViewShape.js";

const graphShape = investigationGraphSchema.shape;
export const investigationGraphViewRequestSchema = z.strictObject({
  kind: z.literal("investigation-graph"),
  scenario_id: graphShape.scenarios.element.shape.id,
  target_revision_id: graphShape.target_revision_id.optional(),
  governance_evidence_ids: z
    .array(prefixedDigestSchema("ev"))
    .min(1)
    .max(2)
    .exactOptional()
    .describe(
      "Select one or two governance Evidence IDs for this exact mapping and scenario.",
    ),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().default(64),
});

export const investigationGraphGovernanceItemSchema = z.strictObject({
  evidence_id: prefixedDigestSchema("ev"),
  record: behaviorGovernancePayloadSchema,
  verification: z
    .strictObject({
      status: obligationStatusSchema,
      verifier_status:
        reconstructionObligationManifestBindingSchema.shape.verifier
          .unwrap()
          .shape.status.nullable(),
      verifier_evidence_id: prefixedDigestSchema("ev").nullable(),
    })
    .nullable(),
});

export const investigationGraphViewItemSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("variant"),
    value: graphShape.variants.element,
  }),
  z.strictObject({
    kind: z.literal("component"),
    value: graphShape.components.element,
  }),
  z.strictObject({
    kind: z.literal("relation"),
    value: graphShape.relations.element,
  }),
  z.strictObject({
    kind: z.literal("claim"),
    value: graphShape.claims.element,
    revision_applicability: z.enum(["current", "other-revision", "unresolved"]),
  }),
  z.strictObject({ kind: z.literal("gap"), value: graphShape.gaps.element }),
]);
export const investigationGraphScenarioSchema = graphShape.scenarios.element;
export const investigationGraphSourceCoverageSchema =
  graphShape.coverage.describe(
    "Analyst-declared mapping coverage, not the coverage of the linked source Evidence.",
  );
const readGraph = createAnalysisViewResultReader(investigationGraphSchema);

const scenarioItems = (
  graph: InvestigationGraph,
  scenario: InvestigationGraph["scenarios"][number],
  revision: string,
) => {
  const variants = graph.variants.filter(
    (item) => item.scenario_id === scenario.id,
  );
  const variantIds = new Set(variants.map((item) => item.id));
  const scenarioEndpoint = (endpoint: { kind: string; id: string }) =>
    (endpoint.kind === "scenario" && endpoint.id === scenario.id) ||
    (endpoint.kind === "variant" && variantIds.has(endpoint.id));
  const relations = graph.relations.filter(
    (item) => scenarioEndpoint(item.from) || scenarioEndpoint(item.to),
  );
  const componentIds = new Set(
    relations
      .flatMap((item) => [item.from, item.to])
      .filter((item) => item.kind === "component")
      .map((item) => item.id),
  );
  const relevant = (subject: { kind: string; id: string }) =>
    scenarioEndpoint(subject) ||
    (subject.kind === "component" && componentIds.has(subject.id));
  const claims = graph.claims.filter(
    (value) =>
      (relevant(value.subject) ||
        (value.variant_id !== null && variantIds.has(value.variant_id))) &&
      (value.variant_id === null || variantIds.has(value.variant_id)),
  );
  const gaps = graph.gaps.filter(
    (value) =>
      relevant(value.subject) ||
      value.migration_checks.some(
        (check) =>
          check.variant_id !== null && variantIds.has(check.variant_id),
      ),
  );
  for (const item of [...claims, ...gaps])
    if (item.subject.kind === "component") componentIds.add(item.subject.id);
  type Item = z.output<typeof investigationGraphViewItemSchema>;
  const items: Item[] = [
    ...variants.map((value): Item => ({ kind: "variant", value })),
    ...graph.components
      .filter((value) => componentIds.has(value.id))
      .map((value): Item => ({ kind: "component", value })),
    ...relations.map((value): Item => ({ kind: "relation", value })),
    ...claims.map((value): Item => ({
      kind: "claim",
      value,
      revision_applicability:
        value.target_revision_id !== revision
          ? "other-revision"
          : value.applicability === "unresolved"
            ? "unresolved"
            : "current",
    })),
    ...gaps.map((value): Item => ({
      kind: "gap",
      value: {
        ...value,
        migration_checks: value.migration_checks.filter(
          (check) =>
            check.variant_id === null || variantIds.has(check.variant_id),
        ),
      },
    })),
  ];
  items.sort((a, b) =>
    a.value.id < b.value.id ? -1 : a.value.id > b.value.id ? 1 : 0,
  );
  return items;
};

/** Project only explicitly associated scenario facts, preserving producer coverage. */
export const projectInvestigationGraphView = (
  parent: AnalysisViewParent,
  admitted: AdmittedView,
) => {
  const view = ownedView<z.output<typeof investigationGraphViewRequestSchema>>(
    admitted,
    "investigation-graph",
  );
  if (view === undefined)
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Investigation graph Evidence requires an investigation-graph scenario selection.",
        },
      ]),
    );
  const parsed = readGraph(parent);
  if (!parsed.ok) return parsed;
  const graph = parsed.value;
  const scenario = graph.scenarios.find((item) => item.id === view.scenario_id);
  if (scenario === undefined)
    return err(
      analysisViewInputError([
        {
          path: ["view", "scenario_id"],
          reason: "invalid_value",
          message: "The selected scenario is absent from this graph snapshot.",
        },
      ]),
    );
  const revision = view.target_revision_id ?? graph.target_revision_id;
  const items = scenarioItems(graph, scenario, revision);
  const governance = parent.investigationGovernance;
  if (governance !== undefined) {
    const claimIds = new Set(
      items.flatMap((item) => (item.kind === "claim" ? [item.value.id] : [])),
    );
    if (governance.some((item) => !claimIds.has(item.record.claim_id)))
      return err(
        analysisViewInputError([
          {
            path: ["view", "governance_evidence_ids"],
            reason: "invalid_value",
            message:
              "A selected governance decision does not belong to this scenario.",
          },
        ]),
      );
  }
  const page = items.slice(view.offset, view.offset + view.limit);
  const sourceLimitations = boundedViewMessages(
    graph.coverage.limitations,
    parent.evidenceId,
    "limitations",
  );
  const projection = {
    kind: "investigation-graph" as const,
    parent_evidence_id: parent.evidenceId,
    parent_operation: "update_investigation_graph" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: null,
    view,
    scope_id: graph.scope_id,
    target_revision_id: revision,
    scenario,
    source_coverage: {
      status: graph.coverage.status,
      limitations: sourceLimitations,
    },
    items: page,
    ...(governance === undefined ? {} : { governance }),
    coverage: pageViewCoverage(view.offset, page.length, items.length),
    limitations: boundedViewMessages(
      [...parent.limitations, ...graph.coverage.limitations],
      parent.evidenceId,
      "limitations",
    ),
    unknowns: [],
  };
  if (
    jsonValueByteLength(projection as unknown as JsonValue, 1024 * 1024 - 128) >
    1024 * 1024 - 128
  )
    return err(
      fixedCeilingConstraint(
        INSPECT_ANALYSIS_VIEW_OPERATION,
        "transport",
        "Investigation graph view exceeds its 1 MiB serialized allowance.",
        {
          name: "The investigation graph view allowance",
          kind: "bytes",
          limit: 1024 * 1024,
          unit: "bytes",
          narrowing:
            "Select a smaller page or read the parent Evidence from the retained bundle.",
        },
      ),
    );
  return ok(projection);
};

import { z } from "zod";
import { coverageStatusSchema } from "./coverage.js";
import { digestSchema, prefixedDigestSchema } from "./digests.js";
import { evidenceAuthoritySchema } from "./evidence.js";
import { evidenceInputSchema } from "./evidenceReference.js";
import { err, ok, type Result } from "./result.js";

const id = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, "Expected a stable identifier");
const text = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "Expected nonblank text");
const evidenceId = prefixedDigestSchema("ev");
const endpoint = z.strictObject({
  kind: z.enum(["component", "scenario", "variant"]),
  id,
});
const component = z.strictObject({ id, name: text });
const scenario = z.strictObject({ id, name: text });
const variant = z.strictObject({
  id,
  scenario_id: id,
  name: text,
  conditions: z.array(text),
});
const relation = z.strictObject({
  id,
  from: endpoint,
  to: endpoint,
  type: text,
});
const binding = z.strictObject({
  evidence_id: evidenceId,
  role: z.enum(["supporting", "contradicting"]),
  target_revision_id: id.nullable(),
  identity_evidence_id: evidenceId.nullable(),
});
const claim = z
  .strictObject({
    id,
    subject: endpoint,
    target_revision_id: id,
    variant_id: id.nullable(),
    statement: text,
    confidence: z.enum(["observed", "derived", "inferred"]),
    rationale: text.nullable(),
    sources: z.array(binding),
  })
  .superRefine((value, context) => {
    if (value.confidence === "inferred" && value.rationale === null)
      context.addIssue({
        code: "custom",
        path: ["rationale"],
        message: "Inferred claims require a rationale",
      });
    const ids = new Set<string>();
    value.sources.forEach((source, index) => {
      if (ids.has(source.evidence_id))
        context.addIssue({
          code: "custom",
          path: ["sources", index, "evidence_id"],
          message: "A source may have only one role per claim",
        });
      ids.add(source.evidence_id);
    });
  });
const gap = z.strictObject({
  id,
  subject: endpoint,
  question: text,
  unknown: z
    .strictObject({
      unknown_id: prefixedDigestSchema("unk"),
      revision: z.int().min(1),
      revision_digest: digestSchema,
    })
    .nullable(),
  migration_checks: z.array(
    z.strictObject({
      action: text,
      variant_id: id.nullable(),
      required_evidence: text.nullable(),
      required_authority: evidenceAuthoritySchema.nullable(),
    }),
  ),
});
const coverage = z.strictObject({
  status: coverageStatusSchema,
  limitations: z.array(text),
});
const entityGroups = [
  "components",
  "scenarios",
  "variants",
  "relations",
  "claims",
  "gaps",
] as const;
const checkUniqueIds = (
  value: Record<(typeof entityGroups)[number], readonly { id: string }[]>,
  context: z.RefinementCtx,
) => {
  const ids = new Set<string>();
  for (const group of entityGroups)
    value[group].forEach((item, index) => {
      if (ids.has(item.id))
        context.addIssue({
          code: "custom",
          path: [group, index, "id"],
          message: "Entity IDs must be unique",
        });
      ids.add(item.id);
    });
};

/** A patch contains complete records to add or replace by stable ID. */
export const investigationGraphPatchSchema = z
  .strictObject({
    components: z.array(component),
    scenarios: z.array(scenario),
    variants: z.array(variant),
    relations: z.array(relation),
    claims: z.array(claim),
    gaps: z.array(gap),
    coverage,
  })
  .superRefine(checkUniqueIds);
export const investigationGraphUpdateSchema = z.strictObject({
  scope_id: id,
  target_revision_id: id,
  previous: evidenceInputSchema.exactOptional(),
  sources: z.array(evidenceInputSchema),
  patch: investigationGraphPatchSchema,
});

/** The composed snapshot validates all references, including those from a predecessor. */
export const investigationGraphSchema = z
  .strictObject({
    format_version: z.literal(1),
    scope_id: id,
    target_revision_id: id,
    previous_evidence_id: evidenceId.nullable(),
    source_evidence_ids: z.array(evidenceId),
    components: z.array(component),
    scenarios: z.array(scenario),
    variants: z.array(variant),
    relations: z.array(relation),
    claims: z.array(
      claim.safeExtend({ applicability: z.enum(["supported", "unresolved"]) }),
    ),
    gaps: z.array(gap),
    coverage,
  })
  .superRefine((graph, context) => {
    checkUniqueIds(graph, context);
    const components = new Set(graph.components.map((item) => item.id));
    const scenarios = new Set(graph.scenarios.map((item) => item.id));
    const variants = new Map(graph.variants.map((item) => [item.id, item]));
    const checkEndpoint = (
      value: z.infer<typeof endpoint>,
      path: (string | number)[],
    ) => {
      const found =
        value.kind === "component"
          ? components.has(value.id)
          : value.kind === "scenario"
            ? scenarios.has(value.id)
            : variants.has(value.id);
      if (!found)
        context.addIssue({
          code: "custom",
          path: [...path, "id"],
          message: "Referenced entity does not exist",
        });
    };
    graph.variants.forEach((item, index) => {
      if (!scenarios.has(item.scenario_id))
        context.addIssue({
          code: "custom",
          path: ["variants", index, "scenario_id"],
          message: "Referenced scenario does not exist",
        });
    });
    graph.relations.forEach((item, index) => {
      checkEndpoint(item.from, ["relations", index, "from"]);
      checkEndpoint(item.to, ["relations", index, "to"]);
    });
    const checkVariant = (
      subject: z.infer<typeof endpoint>,
      variantId: string | null,
      path: (string | number)[],
    ) => {
      if (variantId === null) return;
      const selected = variants.get(variantId);
      if (
        selected === undefined ||
        (subject.kind === "scenario" && selected.scenario_id !== subject.id) ||
        (subject.kind === "variant" && subject.id !== variantId)
      )
        context.addIssue({
          code: "custom",
          path,
          message: "Variant must exist and belong to the subject scenario",
        });
    };
    graph.claims.forEach((item, index) => {
      checkEndpoint(item.subject, ["claims", index, "subject"]);
      checkVariant(item.subject, item.variant_id, [
        "claims",
        index,
        "variant_id",
      ]);
    });
    graph.gaps.forEach((item, index) => {
      checkEndpoint(item.subject, ["gaps", index, "subject"]);
      item.migration_checks.forEach((check, checkIndex) =>
        checkVariant(item.subject, check.variant_id, [
          "gaps",
          index,
          "migration_checks",
          checkIndex,
          "variant_id",
        ]),
      );
    });
    if (
      new Set(graph.source_evidence_ids).size !==
      graph.source_evidence_ids.length
    )
      context.addIssue({
        code: "custom",
        path: ["source_evidence_ids"],
        message: "Source Evidence IDs must be unique",
      });
    const sourceIds = new Set(graph.source_evidence_ids);
    graph.claims.forEach((item, index) =>
      item.sources.forEach((source, sourceIndex) => {
        for (const field of ["evidence_id", "identity_evidence_id"] as const)
          if (source[field] !== null && !sourceIds.has(source[field]))
            context.addIssue({
              code: "custom",
              path: ["claims", index, "sources", sourceIndex, field],
              message:
                "Referenced Evidence must be included in source_evidence_ids",
            });
      }),
    );
  });

export type InvestigationGraphPatch = z.infer<
  typeof investigationGraphPatchSchema
>;
export type InvestigationGraphUpdate = z.infer<
  typeof investigationGraphUpdateSchema
>;
export type InvestigationGraph = z.infer<typeof investigationGraphSchema>;
export type InvestigationGraphAdmissionError = {
  readonly code: "invalid-input";
  readonly issues: readonly z.core.$ZodIssue[];
};

/** Parse untrusted updates without coercion or loss of field-specific issues. */
export const parseInvestigationGraphUpdate = (
  input: unknown,
): Result<InvestigationGraphUpdate, InvestigationGraphAdmissionError> => {
  const parsed = investigationGraphUpdateSchema.safeParse(input);
  return parsed.success
    ? ok(parsed.data)
    : err({ code: "invalid-input", issues: parsed.error.issues });
};

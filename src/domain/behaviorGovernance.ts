import { z } from "zod";

import { prefixedDigestSchema } from "./digests.js";
import { createEvidence, type Evidence } from "./evidence.js";
import { readEvidence } from "./evidenceValidation.js";
import { evidenceInputSchema } from "./evidenceReference.js";
import { investigationGraphSchema } from "./investigationGraph.js";
import { REA_WORKFLOW_PROVIDER } from "./investigationProviders.js";
import { err, ok, type Result } from "./result.js";
import { unknownTarget } from "./targetIdentity.js";

const stableIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, "Expected a stable identifier");
const nonBlankTextSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, "Expected nonblank text");

const behaviorReasonSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("known"), text: nonBlankTextSchema }),
  z.strictObject({ status: z.literal("unknown") }),
]);
const actorClaimSchema = z.strictObject({
  status: z.literal("declared"),
  value: nonBlankTextSchema,
});
const migrationDisposition = z.enum([
  "preserve",
  "change-deliberately",
  "retire",
  "defer",
]);
const obligationSelection = {
  obligation_id: z.string().min(1),
  obligation_version: z.int().min(1),
};
const verificationReference = z.strictObject({
  ...obligationSelection,
  ledger_evidence_id: prefixedDigestSchema("ev"),
});

const commonPayload = {
  format_version: z.literal(1),
  scope_id: stableIdSchema,
  revision_id: stableIdSchema,
  previous_evidence_id: prefixedDigestSchema("ev").nullable(),
  mapping_evidence_id: prefixedDigestSchema("ev"),
  claim_id: stableIdSchema,
  reason: behaviorReasonSchema,
  actor_claim: actorClaimSchema,
  approval: z.strictObject({ status: z.literal("pending") }),
  verification: verificationReference.exactOptional(),
};

/** Versioned normalized payloads keep each history's disposition vocabulary strict. */
export const behaviorGovernancePayloadSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...commonPayload,
    kind: z.literal("source-system"),
    disposition: z.literal("confirmed"),
  }),
  z.strictObject({
    ...commonPayload,
    kind: z.literal("migration"),
    disposition: migrationDisposition,
    origin_governance_evidence_id: prefixedDigestSchema("ev").exactOptional(),
  }),
]);

export type BehaviorGovernancePayload = z.infer<
  typeof behaviorGovernancePayloadSchema
>;
export type BehaviorGovernanceEvidence = Evidence<BehaviorGovernancePayload>;

const commonInput = {
  scope_id: stableIdSchema,
  revision_id: stableIdSchema,
  previous: z.unknown().nullable(),
  mapping_evidence: z.unknown(),
  claim_id: stableIdSchema,
  reason: behaviorReasonSchema,
  actor_claim: actorClaimSchema,
};

const sourceDecision = {
  kind: z.literal("source-system"),
  disposition: z.literal("confirmed"),
};
const migrationDecision = {
  kind: z.literal("migration"),
  disposition: migrationDisposition,
};

const requestShape = {
  ...commonInput,
  previous: evidenceInputSchema.nullable(),
  mapping_evidence: evidenceInputSchema,
  verification: z
    .strictObject({
      ...obligationSelection,
      ledger: evidenceInputSchema,
    })
    .exactOptional(),
};

export const behaviorGovernanceRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...requestShape, ...sourceDecision }),
  z.strictObject({
    ...requestShape,
    ...migrationDecision,
    origin_governance: evidenceInputSchema.exactOptional(),
  }),
]);

const behaviorGovernanceInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...commonInput,
    ...sourceDecision,
    verification: verificationReference.exactOptional(),
  }),
  z.strictObject({
    ...commonInput,
    ...migrationDecision,
    verification: verificationReference.exactOptional(),
    origin_governance: z.unknown().exactOptional(),
  }),
]);

export type BehaviorGovernanceError = {
  readonly kind:
    | "invalid-input"
    | "invalid-evidence"
    | "invalid-mapping-evidence"
    | "mapping-scope-mismatch"
    | "claim-not-found"
    | "invalid-predecessor"
    | "invalid-origin-governance";
  readonly message: string;
};

type ParsedGovernanceEvidence = {
  readonly evidence: BehaviorGovernanceEvidence;
  readonly payload: BehaviorGovernancePayload;
};

const GOVERNANCE_PREDICATE = "rea.behavior-governance";
const GOVERNANCE_OPERATION = "record_behavior_governance";
const GRAPH_PREDICATE = "rea.investigation-graph";
const GRAPH_OPERATION = "update_investigation_graph";

const sameWorkflowProvider = (evidence: Evidence): boolean =>
  evidence.provider.id === REA_WORKFLOW_PROVIDER.id &&
  evidence.provider.name === REA_WORKFLOW_PROVIDER.name &&
  evidence.provider.version === REA_WORKFLOW_PROVIDER.version;

const readCanonicalEvidence = (
  value: unknown,
): Result<Evidence, BehaviorGovernanceError> => {
  const result = readEvidence(value);
  return result.ok
    ? result
    : err({
        kind: "invalid-evidence",
        message: result.error.message,
      });
};

export const parseGovernanceEvidence = (
  value: unknown,
): Result<ParsedGovernanceEvidence, BehaviorGovernanceError> => {
  const parsedEvidence = readCanonicalEvidence(value);
  if (!parsedEvidence.ok) return parsedEvidence;
  const evidence = parsedEvidence.value;
  if (
    !sameWorkflowProvider(evidence) ||
    evidence.predicate_type !== GOVERNANCE_PREDICATE ||
    evidence.operation !== GOVERNANCE_OPERATION
  )
    return err({
      kind: "invalid-evidence",
      message: "Evidence is not a behavior-governance record",
    });
  const parsedPayload = behaviorGovernancePayloadSchema.safeParse(
    evidence.normalized_result,
  );
  if (!parsedPayload.success)
    return err({
      kind: "invalid-evidence",
      message: "Behavior-governance Evidence has an invalid versioned payload",
    });
  return ok({
    evidence: evidence as BehaviorGovernanceEvidence,
    payload: parsedPayload.data,
  });
};

/**
 * Create a canonical, pending governance record tied to one exact graph claim.
 * Actor identity remains a declaration until an application authorizes it.
 */
export const createBehaviorGovernanceEvidence = (
  input: unknown,
): Result<BehaviorGovernanceEvidence, BehaviorGovernanceError> => {
  const parsedInput = behaviorGovernanceInputSchema.safeParse(input);
  if (!parsedInput.success)
    return err({
      kind: "invalid-input",
      message: "Behavior-governance input does not match its tagged contract",
    });
  const value = parsedInput.data;

  const mappingResult = readCanonicalEvidence(value.mapping_evidence);
  if (!mappingResult.ok)
    return err({
      kind: "invalid-mapping-evidence",
      message: mappingResult.error.message,
    });
  const mapping = mappingResult.value;
  if (
    !sameWorkflowProvider(mapping) ||
    mapping.predicate_type !== GRAPH_PREDICATE ||
    mapping.operation !== GRAPH_OPERATION
  )
    return err({
      kind: "invalid-mapping-evidence",
      message:
        "Mapping Evidence must be a canonical investigation-graph result",
    });
  const parsedGraph = investigationGraphSchema.safeParse(
    mapping.normalized_result,
  );
  if (!parsedGraph.success)
    return err({
      kind: "invalid-mapping-evidence",
      message: "Mapping Evidence does not contain a valid investigation graph",
    });
  const graph = parsedGraph.data;
  if (
    mapping.parameters.scope_id !== graph.scope_id ||
    mapping.parameters.target_revision_id !== graph.target_revision_id
  )
    return err({
      kind: "mapping-scope-mismatch",
      message: "Selected scope does not match the graph Evidence",
    });
  if (value.kind === "source-system" && graph.scope_id !== value.scope_id)
    return err({
      kind: "mapping-scope-mismatch",
      message: "Source-system scope must match the mapped graph scope",
    });
  if (!graph.claims.some((claim) => claim.id === value.claim_id))
    return err({
      kind: "claim-not-found",
      message: "Selected claim does not exist in the graph Evidence",
    });

  let previous: ParsedGovernanceEvidence | null = null;
  if (value.previous !== null) {
    const parsedPrevious = parseGovernanceEvidence(value.previous);
    if (
      !parsedPrevious.ok ||
      parsedPrevious.value.payload.kind !== value.kind ||
      parsedPrevious.value.payload.scope_id !== value.scope_id
    )
      return err({
        kind: "invalid-predecessor",
        message:
          "Predecessor must be canonical Evidence of the same kind and scope",
      });
    previous = parsedPrevious.value;
  }

  let origin: ParsedGovernanceEvidence | null = null;
  if (value.kind === "migration" && value.origin_governance !== undefined) {
    const parsedOrigin = parseGovernanceEvidence(value.origin_governance);
    if (
      !parsedOrigin.ok ||
      parsedOrigin.value.payload.kind !== "source-system" ||
      parsedOrigin.value.payload.scope_id !== graph.scope_id ||
      parsedOrigin.value.payload.claim_id !== value.claim_id
    )
      return err({
        kind: "invalid-origin-governance",
        message:
          "Migration origin must be source-system Evidence for the mapped scope and claim",
      });
    origin = parsedOrigin.value;
  }

  const payload = behaviorGovernancePayloadSchema.parse({
    format_version: 1,
    kind: value.kind,
    scope_id: value.scope_id,
    revision_id: value.revision_id,
    previous_evidence_id: previous?.evidence.evidence_id ?? null,
    mapping_evidence_id: mapping.evidence_id,
    claim_id: value.claim_id,
    disposition: value.disposition,
    reason: value.reason,
    actor_claim: value.actor_claim,
    approval: { status: "pending" },
    ...(value.verification === undefined
      ? {}
      : { verification: value.verification }),
    ...(origin === null
      ? {}
      : { origin_governance_evidence_id: origin.evidence.evidence_id }),
  });
  const evidenceLinks = [
    mapping.evidence_id,
    ...(previous === null ? [] : [previous.evidence.evidence_id]),
    ...(origin === null ? [] : [origin.evidence.evidence_id]),
    ...(value.verification === undefined
      ? []
      : [value.verification.ledger_evidence_id]),
  ];
  const evidence = createEvidence(
    unknownTarget("derived-from-linked-evidence"),
    REA_WORKFLOW_PROVIDER,
    {
      predicateType: GOVERNANCE_PREDICATE,
      operation: GOVERNANCE_OPERATION,
      parameters: {
        kind: value.kind,
        scope_id: value.scope_id,
        revision_id: value.revision_id,
      },
      result: payload,
      confidence: "derived",
      evidenceLinks,
    },
    { immutable: true },
  );
  return ok(evidence as BehaviorGovernanceEvidence);
};

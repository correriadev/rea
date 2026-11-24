import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  readImmutableEvidence,
  readEvidencePayload,
} from "../../domain/evidenceValidation.js";
import {
  investigationGraphSchema,
  investigationGraphUpdateSchema,
  type InvestigationGraph,
} from "../../domain/investigationGraph.js";
import { REA_WORKFLOW_PROVIDER } from "../../domain/investigationProviders.js";
import { createAnalysisProfile } from "../../domain/analysisProfile.js";
import {
  sameTargetIdentity,
  unknownTarget,
} from "../../domain/targetIdentity.js";
import {
  AnalysisInputError,
  cancelledBy,
} from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { EvidenceReferenceError } from "../../domain/evidenceErrors.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { uniqueSorted } from "../../domain/canonicalOrdering.js";
import { err, ok, type Result } from "../../domain/result.js";
import { resolveEvidenceRequest } from "../EvidenceInputResolver.js";
import { resolveInvestigationEvidenceClosure } from "./InvestigationEvidence.js";
import type { EvidenceReader } from "./InvestigationRecordPort.js";
import type { InvestigationWorkflowExecution } from "./InvestigationWorkflows.js";

const operation = "update_investigation_graph";
const predicate = "rea.investigation-graph";
type Reader = Pick<
  EvidenceReader,
  "evidenceForAnalysis" | "immutableEvidenceBundle"
>;

const invalid = (
  path: (string | number)[],
  message: string,
): AnalysisInputError =>
  new AnalysisInputError(operation, { userMessage: message }, [
    { path, reason: "invalid_value", message },
  ]);

const merge = <T extends { id: string }>(
  previous: readonly T[],
  patch: readonly T[],
): T[] => {
  const values = new Map(previous.map((item) => [item.id, item]));
  for (const item of patch) values.set(item.id, item);
  return [...values.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
};

/** Compose an immutable graph from authenticated, explicitly selected Evidence. */
export const updateInvestigationGraph = (
  input: unknown,
  reader: Reader,
  signal?: AbortSignal,
): Result<InvestigationWorkflowExecution, AnalysisError> => {
  const selected = resolveEvidenceRequest(
    operation,
    input,
    investigationGraphUpdateSchema,
    (id) => reader.evidenceForAnalysis(id),
    {
      ...(signal === undefined ? {} : { signal }),
      referenceScope: "retained-closure",
      readEvidence: readImmutableEvidence,
    },
  );
  if (!selected.ok) return selected;
  const request = selected.value.input;
  const sources = selected.value.sources as Evidence[];
  const known = new Map(
    sources.map((evidence) => [evidence.evidence_id, evidence]),
  );
  const lookup = (id: string): Evidence | undefined => {
    if (!known.has(id)) {
      const found = reader.evidenceForAnalysis(id);
      if (found !== undefined) known.set(id, found);
    }
    return known.get(id);
  };
  const cancelled = () =>
    signal?.aborted ? err(cancelledBy(operation, signal)) : undefined;
  let parent: InvestigationGraph | undefined;
  if (request.previous !== undefined) {
    const previous = request.previous;
    if (
      previous.operation !== operation ||
      previous.predicate_type !== predicate
    )
      return err(
        invalid(
          ["previous"],
          "Previous Evidence is not an investigation graph snapshot.",
        ),
      );
    const parsed = readEvidencePayload(
      investigationGraphSchema,
      previous.normalized_result,
      { within: ["normalized_result"] },
    );
    if (!parsed.ok) return parsed;
    parent = parsed.value;
    if (parent.scope_id !== request.scope_id)
      return err(
        invalid(["previous"], "Previous graph belongs to a different scope."),
      );
  }
  const sourceIds = uniqueSorted([
    ...(parent?.source_evidence_ids ?? []),
    ...request.sources.map((item) => item.evidence_id),
    ...request.patch.claims.flatMap((claim) =>
      claim.sources.flatMap((binding) =>
        binding.identity_evidence_id === null
          ? [binding.evidence_id]
          : [binding.evidence_id, binding.identity_evidence_id],
      ),
    ),
  ]);
  const links = [
    ...sourceIds,
    ...(request.previous === undefined ? [] : [request.previous.evidence_id]),
  ];
  const gaps = merge(parent?.gaps ?? [], request.patch.gaps);
  const pins = gaps.flatMap((gap) =>
    gap.unknown === null ? [] : [gap.unknown],
  );
  if (pins.length > 0) {
    const unknowns = reader.immutableEvidenceBundle().unknowns;
    for (const pin of pins) {
      const found = unknowns.find(
        (item) =>
          item.unknown_id === pin.unknown_id &&
          item.revision === pin.revision &&
          item.revision_digest === pin.revision_digest,
      );
      if (found === undefined)
        return err(
          invalid(
            ["patch", "gaps"],
            `Unknown revision ${pin.unknown_id}:${String(pin.revision)} is unavailable.`,
          ),
        );
      links.push(...found.mutation_evidence_ids);
    }
  }
  const closure = resolveInvestigationEvidenceClosure(
    { evidenceForAnalysis: lookup },
    links,
    sources,
  );
  const interrupted = cancelled();
  if (interrupted !== undefined) return interrupted;
  if (!closure.ok) return closure;

  const claims = merge<InvestigationGraph["claims"][number]>(
    parent?.claims ?? [],
    request.patch.claims.map((claim) => ({
      ...claim,
      applicability: "unresolved",
    })),
  );
  for (const claim of claims) {
    let supported = false;
    for (const binding of claim.sources) {
      const evidence = lookup(binding.evidence_id);
      const anchor =
        binding.identity_evidence_id === null
          ? undefined
          : lookup(binding.identity_evidence_id);
      if (evidence === undefined)
        return err(
          new EvidenceReferenceError(binding.evidence_id, "missing", {
            expected: "Selected source Evidence",
            actual: null,
          }),
        );
      if (binding.identity_evidence_id !== null && anchor === undefined)
        return err(
          new EvidenceReferenceError(binding.identity_evidence_id, "missing", {
            expected: "Identity anchor Evidence",
            actual: null,
          }),
        );
      const actual = evidence.subject.identity;
      const expected = anchor?.subject.identity;
      const comparable =
        expected !== undefined &&
        actual.kind !== "unknown" &&
        expected.kind === actual.kind;
      if (comparable && !sameTargetIdentity(actual, expected))
        return err(
          invalid(
            ["patch", "claims", claim.id, "sources", binding.evidence_id],
            "Source identity does not match its explicit revision identity anchor.",
          ),
        );
      if (
        comparable &&
        binding.role === "supporting" &&
        binding.target_revision_id === claim.target_revision_id &&
        (claim.confidence !== "observed" || evidence.confidence === "observed")
      )
        supported = true;
    }
    claim.applicability = supported ? "supported" : "unresolved";
    const stopped = cancelled();
    if (stopped !== undefined) return stopped;
  }
  const graph = investigationGraphSchema.safeParse({
    format_version: 1,
    scope_id: request.scope_id,
    target_revision_id: request.target_revision_id,
    previous_evidence_id: request.previous?.evidence_id ?? null,
    source_evidence_ids: sourceIds,
    components: merge(parent?.components ?? [], request.patch.components),
    scenarios: merge(parent?.scenarios ?? [], request.patch.scenarios),
    variants: merge(parent?.variants ?? [], request.patch.variants),
    relations: merge(parent?.relations ?? [], request.patch.relations),
    claims,
    gaps,
    coverage: request.patch.coverage,
  });
  if (!graph.success)
    return err(
      analysisInputErrorFromIssues(operation, graph.error.issues, input),
    );
  const stopped = cancelled();
  if (stopped !== undefined) return stopped;
  const evidence = createEvidence(
    unknownTarget("derived-from-linked-evidence"),
    REA_WORKFLOW_PROVIDER,
    {
      predicateType: predicate,
      operation,
      analysisProfile: createAnalysisProfile(REA_WORKFLOW_PROVIDER, {
        workflow_revision: 1,
      }),
      parameters: {
        scope_id: request.scope_id,
        target_revision_id: request.target_revision_id,
      },
      result: graph.data,
      confidence: "derived",
      authority: "analyst-inference",
      limitations: graph.data.coverage.limitations,
      evidenceLinks: closure.value,
    },
    { immutable: true },
  );
  return ok({ evidence, sources, unknown: undefined });
};

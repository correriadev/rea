import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  cancelledBy,
} from "../../domain/analysisErrorCore.js";
import {
  behaviorGovernanceRequestSchema,
  createBehaviorGovernanceEvidence,
  parseGovernanceEvidence,
  type BehaviorGovernancePayload,
} from "../../domain/behaviorGovernance.js";
import { EvidenceReferenceError } from "../../domain/evidenceErrors.js";
import type { Evidence } from "../../domain/evidence.js";
import {
  readEvidencePayload,
  readImmutableEvidence,
} from "../../domain/evidenceValidation.js";
import { reconstructionObligationLedgerSchema } from "../../domain/reconstructionObligationLedgerSchemas.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  resolveEvidenceRequest,
  type EvidenceLookup,
} from "../EvidenceInputResolver.js";
import { resolveInvestigationEvidenceClosure } from "./InvestigationEvidence.js";
import type { InvestigationSnapshotReader } from "./InvestigationSnapshotBundle.js";
import type { InvestigationWorkflowExecution } from "./InvestigationWorkflows.js";

const operation = "record_behavior_governance";

const invalid = (owner: string, path: string[], message: string) =>
  new AnalysisInputError(owner, { userMessage: message }, [
    { path, reason: "invalid_value", message },
  ]);

const resolveObligation = (
  record: Evidence,
  selection: { obligation_id: string; obligation_version: number },
  mappingId: string,
  owner: string,
  path: string[],
) => {
  if (
    record.predicate_type !== "rea.reconstruction-obligation-ledger" ||
    record.operation !== "build_reconstruction_obligation_ledger"
  )
    return err(
      invalid(owner, path, "Select reconstruction obligation ledger Evidence."),
    );
  const ledger = readEvidencePayload(
    reconstructionObligationLedgerSchema,
    record.normalized_result,
    {
      within: ["normalized_result"],
    },
  );
  if (!ledger.ok) return ledger;
  const obligation = ledger.value.obligations.find(
    (item) =>
      item.obligation_id === selection.obligation_id &&
      item.obligation_version === selection.obligation_version,
  );
  return obligation === undefined ||
    !obligation.authority_references.some(
      ({ evidence_id }) => evidence_id === mappingId,
    )
    ? err(
        invalid(
          owner,
          path,
          "The selected obligation revision must cite this mapping snapshot.",
        ),
      )
    : ok(obligation);
};

export const recordBehaviorGovernance = (
  input: unknown,
  reader: InvestigationSnapshotReader,
  signal?: AbortSignal,
): Result<InvestigationWorkflowExecution, AnalysisError> => {
  const selected = resolveEvidenceRequest(
    operation,
    input,
    behaviorGovernanceRequestSchema,
    (id) => reader.evidenceForAnalysis(id),
    {
      ...(signal === undefined ? {} : { signal }),
      referenceScope: "retained-closure",
      readEvidence: readImmutableEvidence,
    },
  );
  if (!selected.ok) return selected;
  const { verification, ...decision } = selected.value.input;
  if (verification !== undefined) {
    const obligation = resolveObligation(
      verification.ledger,
      verification,
      decision.mapping_evidence.evidence_id,
      operation,
      ["verification"],
    );
    if (!obligation.ok) return obligation;
  }
  const result = createBehaviorGovernanceEvidence({
    ...decision,
    ...(verification === undefined
      ? {}
      : {
          verification: {
            ledger_evidence_id: verification.ledger.evidence_id,
            obligation_id: verification.obligation_id,
            obligation_version: verification.obligation_version,
          },
        }),
  });
  if (!result.ok)
    return err(invalid(operation, ["decision"], result.error.message));
  const sources = selected.value.sources as readonly Evidence[];
  const closure = resolveInvestigationEvidenceClosure(
    reader,
    result.value.evidence_links,
    sources,
  );
  if (signal?.aborted) return err(cancelledBy(operation, signal));
  return closure.ok
    ? ok({ evidence: result.value, sources, unknown: undefined })
    : closure;
};

export const resolveBehaviorGovernanceView = (
  ids: readonly string[],
  mappingId: string,
  lookup: EvidenceLookup | undefined,
) => {
  const items = [];
  const selectedKinds = new Set<BehaviorGovernancePayload["kind"]>();
  const owner = "inspect_analysis_view";
  const path = ["view", "governance_evidence_ids"];
  for (const id of ids) {
    const record = lookup?.(id);
    if (record === undefined || record.evidence_id !== id)
      return err(
        new EvidenceReferenceError(
          id,
          record === undefined ? "missing" : "identity_mismatch",
          {
            expected: id,
            actual: record?.evidence_id ?? null,
          },
        ),
      );
    const decoded = parseGovernanceEvidence(record);
    if (!decoded.ok) return err(invalid(owner, path, decoded.error.message));
    const payload = decoded.value.payload;
    if (
      payload.mapping_evidence_id !== mappingId ||
      selectedKinds.has(payload.kind)
    )
      return err(
        invalid(
          owner,
          path,
          "Select at most one record of each governance kind for this mapping snapshot.",
        ),
      );
    selectedKinds.add(payload.kind);
    const verification = payload.verification;
    if (verification === undefined) {
      items.push({ evidence_id: id, record: payload, verification: null });
      continue;
    }
    const ledger = lookup?.(verification.ledger_evidence_id);
    if (
      ledger === undefined ||
      ledger.evidence_id !== verification.ledger_evidence_id
    )
      return err(
        new EvidenceReferenceError(
          verification.ledger_evidence_id,
          ledger === undefined ? "missing" : "identity_mismatch",
          {
            expected: verification.ledger_evidence_id,
            actual: ledger?.evidence_id ?? null,
          },
        ),
      );
    const obligation = resolveObligation(
      ledger,
      verification,
      mappingId,
      owner,
      path,
    );
    if (!obligation.ok) return obligation;
    items.push({
      evidence_id: id,
      record: payload,
      verification: {
        status: obligation.value.status,
        verifier_status: obligation.value.binding?.verifier?.status ?? null,
        verifier_evidence_id:
          obligation.value.binding?.verifier?.result_evidence_id ?? null,
      },
    });
  }
  return ok(items);
};

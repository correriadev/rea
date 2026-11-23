import type { Evidence } from "../domain/evidence.js";
import type { ReconstructionObligation } from "../domain/reconstructionObligationLedgerSchemas.js";
import { evidenceSupportsOriginalAuthority } from "./ReconstructionObligationAuthority.js";
import type { ReconstructionObligationCandidate } from "./ReconstructionObligationCandidates.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import { LEGACY_PERSISTENCE_CASES } from "./ReconstructionObligationPolicies.js";
import {
  admitLegacyJourneyReceipt,
  LEGACY_VERIFICATION_OPERATION,
  LEGACY_VERIFICATION_PREDICATE,
} from "./legacyJourneyVerification.js";
import { legacyJourneyReceiptSchema } from "../domain/legacyJourneyProject.js";

type Binding = NonNullable<ReconstructionObligation["binding"]>;
type Diagnostic = ReconstructionObligation["diagnostics"][number];

/** Merge generated and manifest-supplied original observations canonically. */
export const originalCasesFor = (
  candidate: ReconstructionObligationCandidate,
  binding: Binding | null,
): ReconstructionObligation["observed_cases"] =>
  [
    ...new Map(
      [...candidate.observed_cases, ...(binding?.original_cases ?? [])].map(
        (observed) => [
          `${observed.kind}:${observed.evidence_id}:${observed.location}`,
          observed,
        ],
      ),
    ).values(),
  ].sort((left, right) =>
    compareUnicodeCodePoints(
      `${left.kind}:${left.evidence_id}:${left.location}`,
      `${right.kind}:${right.evidence_id}:${right.location}`,
    ),
  );

/** Report original cases that are absent or lack comparable Evidence authority. */
export const originalCaseDiagnostics = (
  candidate: ReconstructionObligationCandidate,
  originalCases: ReconstructionObligation["observed_cases"],
  evidenceById: ReadonlyMap<string, Evidence>,
  binding: Binding | null,
): Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  if (
    LEGACY_PERSISTENCE_CASES.some(
      ({ family }) => family === candidate.family,
    ) &&
    !originalCases.some(({ evidence_id, location }) => {
      const evidence = evidenceById.get(evidence_id);
      if (
        !binding ||
        !evidence ||
        evidence.operation !== LEGACY_VERIFICATION_OPERATION ||
        evidence.predicate_type !== LEGACY_VERIFICATION_PREDICATE ||
        !candidate.authority_references.some((ref) =>
          evidence.evidence_links.includes(ref.evidence_id),
        ) ||
        binding.verifier?.result_evidence_id !== evidence_id
      )
        return false;
      const raw = legacyJourneyReceiptSchema.safeParse(evidence.raw_result);
      if (!raw.success || !candidate.target.artifact_sha256) return false;
      const cases = raw.data.cases;
      const index = cases.findIndex(
        (item) =>
          item.family === candidate.family &&
          item.obligation_id === candidate.obligation_id &&
          item.obligation_version === candidate.obligation_version &&
          item.status !== "unknown",
      );
      if (index < 0 || location !== `/raw_result/cases/${index}`) return false;
      return admitLegacyJourneyReceipt(raw.data, {
        journeyId: raw.data.journey_id,
        baseline: candidate.target.artifact_sha256,
        candidate: binding.owner.owner_sha256,
        obligations: cases,
      }).ok;
    })
  )
    diagnostics.push({
      code: "missing-original-case",
      detail:
        "A journey obligation needs a case-specific original observation from the legacy verifier.",
    });
  // Retain optional case rows, but never leave one of their Evidence links
  // unresolved merely because its kind is not required for closure.
  for (const { kind, evidence_id: evidenceId } of originalCases)
    if (!evidenceById.has(evidenceId))
      diagnostics.push({
        code: "missing-original-case",
        detail: `Original ${kind} case references Evidence ${evidenceId}, which is absent from the bundle.`,
      });
  for (const caseKind of candidate.required_case_kinds) {
    const cases = originalCases.filter(({ kind }) => kind === caseKind);
    if (cases.length === 0) {
      diagnostics.push({
        code: "missing-original-case",
        detail: `Original ${caseKind} behavior has not been observed.`,
      });
      continue;
    }
    if (
      !cases.some(({ evidence_id: evidenceId }) => {
        const evidence = evidenceById.get(evidenceId);
        return (
          evidence !== undefined &&
          evidenceSupportsOriginalAuthority(
            evidence,
            candidate.required_original_authority,
          )
        );
      })
    )
      diagnostics.push({
        code: "weak-original-case-authority",
        detail: `Original ${caseKind} behavior lacks ${candidate.required_original_authority} Evidence.`,
      });
  }
  return diagnostics;
};

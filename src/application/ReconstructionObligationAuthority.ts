import { err, ok, type Result } from "../domain/result.js";
import { parseProcessCaptureEvidence } from "./process/ProcessEvidence.js";
import {
  reconstructionObligationProofSchema,
  type ReconstructionObligationProof,
} from "../domain/reconstructionObligationProof.js";
import type { Evidence } from "../domain/evidence.js";
import { STABLE_IDENTIFIER_PATTERN } from "../domain/stringPatterns.js";
import { isRecord } from "../kernel/isRecord.js";
import type {
  ReconstructionObligation,
  ReconstructionRunRequirements,
} from "../domain/reconstructionObligationLedgerSchemas.js";

type ProofAuthority = ReconstructionObligation["required_fixture_authority"];
type OriginalAuthority =
  ReconstructionObligation["required_original_authority"];
type ExpectedProof = {
  readonly obligationId: string;
  readonly obligationVersion: number;
  readonly ownerSha256: string;
} & (
  | {
      readonly kind: "fixture";
      readonly fixtureId: string;
      readonly caseKind: ReconstructionObligation["required_case_kinds"][number];
    }
  | {
      readonly kind: "verifier";
      readonly verifierId: string;
      readonly claimId: string;
    }
);

type ProofRejection =
  | "unobserved-proof"
  | "unrecognized-proof"
  | "invalid-proof"
  | "insufficient-authority"
  | "obligation-mismatch"
  | "owner-mismatch"
  | "revision-mismatch"
  | "claim-mismatch"
  | "failed-proof"
  | "run-requirements-missing"
  | "run-build-mismatch"
  | "run-conditions-mismatch"
  | "run-witness-missing"
  | "run-witness-unlinked"
  | "run-witness-scope-mismatch"
  | "run-cleanup-incomplete";

type ParsedProof = Result<
  {
    readonly authority: Evidence["authority"];
    readonly result: ReconstructionObligationProof;
    readonly evidenceLinks: Evidence["evidence_links"];
    readonly runId: string | null;
  },
  ProofRejection
>;

interface ProofQualificationContext {
  readonly evidence: ReadonlyMap<string, Evidence>;
  readonly runRequirements?: ReconstructionRunRequirements;
}

const proofEvidenceAuthorities: Readonly<
  Record<ProofAuthority, readonly Evidence["authority"][]>
> = {
  unit: ["shipped-artifact", "controlled-replay"],
  integration: ["controlled-replay"],
  protocol: ["controlled-replay", "external-service"],
  renderer: ["controlled-replay", "external-service"],
  "packaged-process": ["controlled-replay"],
  "native-abi": ["shipped-artifact", "controlled-replay"],
  "live-observation": ["controlled-replay", "external-service"],
  external: ["external-service"],
};

/** Return whether an actual reconstruction proof is comparable to a requirement. */
export const proofAuthoritySatisfies = (
  actual: ProofAuthority,
  required: ProofAuthority,
): boolean => {
  const accepted: Readonly<Record<ProofAuthority, readonly ProofAuthority[]>> =
    {
      unit: [
        "unit",
        "integration",
        "protocol",
        "renderer",
        "packaged-process",
        "native-abi",
        "live-observation",
        "external",
      ],
      integration: [
        "integration",
        "protocol",
        "renderer",
        "packaged-process",
        "native-abi",
        "live-observation",
      ],
      protocol: ["protocol", "packaged-process", "live-observation"],
      renderer: ["renderer", "packaged-process", "live-observation"],
      "packaged-process": ["packaged-process", "live-observation"],
      "native-abi": ["native-abi"],
      "live-observation": ["live-observation"],
      external: ["external"],
    };
  return accepted[required].includes(actual);
};

/** Parse retained proof once; authenticity is checked by bundle admission. */
export const parseReconstructionProofEvidence = (
  evidence: Evidence,
): ParsedProof => {
  if (evidence.confidence !== "observed") return err("unobserved-proof");
  if (
    evidence.predicate_type !== "rea.reconstruction-proof" ||
    evidence.operation !== "verify_reconstruction_obligations"
  )
    return err("unrecognized-proof");
  const parsed = reconstructionObligationProofSchema.safeParse(
    evidence.normalized_result,
  );
  const runId = evidence.parameters.run_id;
  return parsed.success
    ? ok({
        authority: evidence.authority,
        result: parsed.data,
        evidenceLinks: evidence.evidence_links,
        runId:
          typeof runId === "string" && STABLE_IDENTIFIER_PATTERN.test(runId)
            ? runId
            : null,
      })
    : err("invalid-proof");
};

/** Qualify one exact claim, without joining unrelated identities or results. */
export const qualifyReconstructionProof = (
  proof: ParsedProof,
  authority: ProofAuthority,
  expected: ExpectedProof,
  context?: ProofQualificationContext,
): Result<null, ProofRejection> => {
  if (!proof.ok) return proof;
  if (!proofEvidenceAuthorities[authority].includes(proof.value.authority))
    return err("insufficient-authority");
  const obligations = proof.value.result.bindings.filter(
    (binding) => binding.obligation_id === expected.obligationId,
  );
  if (obligations.length === 0) return err("obligation-mismatch");
  const owners = obligations.filter(
    (binding) => binding.owner_sha256 === expected.ownerSha256,
  );
  if (owners.length === 0) return err("owner-mismatch");
  const revisions = owners.filter(
    (binding) => binding.obligation_version === expected.obligationVersion,
  );
  if (revisions.length === 0) return err("revision-mismatch");
  const claims = revisions.flatMap((binding) => {
    const matches =
      expected.kind === "fixture"
        ? binding.fixtures.filter(
            (fixture) =>
              fixture.fixture_id === expected.fixtureId &&
              fixture.case_kind === expected.caseKind,
          )
        : binding.verifiers.filter(
            (verifier) =>
              verifier.verifier_id === expected.verifierId &&
              verifier.claim_id === expected.claimId,
          );
    return matches.map((claim) => ({ binding, passed: claim.passed }));
  });
  if (claims.length === 0) return err("claim-mismatch");
  if (context?.runRequirements !== undefined) {
    let hasApplicableClaim = false;
    let hasApplicableFailure = false;
    let firstInapplicable: ProofRejection | undefined;
    for (const { binding, passed } of claims) {
      const run = qualifyRunReceipt(
        binding,
        expected.ownerSha256,
        proof.value,
        context.runRequirements,
        context.evidence,
      );
      if (!run.ok) {
        firstInapplicable ??= run.error;
        continue;
      }
      hasApplicableClaim = true;
      if (!passed) hasApplicableFailure = true;
    }
    if (hasApplicableFailure) return err("failed-proof");
    if (hasApplicableClaim) return ok(null);
    return err(firstInapplicable ?? "run-requirements-missing");
  }
  return claims.every(({ passed }) => passed) ? ok(null) : err("failed-proof");
};

const qualifyRunReceipt = (
  binding: ReconstructionObligationProof["bindings"][number],
  actualOwnerSha256: string,
  proof: {
    readonly evidenceLinks: readonly string[];
    readonly runId: string | null;
  },
  requirements: ReconstructionRunRequirements,
  evidence: ReadonlyMap<string, Evidence>,
): Result<null, ProofRejection> => {
  const receipt = binding.run;
  if (receipt === undefined) return err("run-requirements-missing");
  if (
    requirements.candidate_owner_sha256 !== actualOwnerSha256 ||
    receipt.baseline_owner_sha256 !== requirements.baseline_owner_sha256 ||
    receipt.candidate_owner_sha256 !== requirements.candidate_owner_sha256
  )
    return err("run-build-mismatch");
  if (receipt.conditions_sha256 !== requirements.conditions_sha256)
    return err("run-conditions-mismatch");
  if (receipt.cleanup !== "complete") return err("run-cleanup-incomplete");
  for (const required of requirements.required_witnesses) {
    const checkpointId =
      typeof required === "string" ? required : required.checkpoint_id;
    const witnesses = receipt.witnesses.filter(
      (witness) => witness.checkpoint_id === checkpointId,
    );
    if (witnesses.length !== 1) return err("run-witness-missing");
    const witness = witnesses[0];
    if (witness === undefined) return err("run-witness-missing");
    const witnessEvidence = evidence.get(witness.evidence_id);
    if (witnessEvidence === undefined) return err("run-witness-missing");
    if (!proof.evidenceLinks.includes(witness.evidence_id))
      return err("run-witness-unlinked");
    if (!isObservedRuntimeCheckpoint(witnessEvidence, checkpointId))
      return err("run-witness-missing");
    const artifactSha256 =
      typeof required !== "string" && required.build_role === "baseline"
        ? receipt.baseline_owner_sha256
        : receipt.candidate_owner_sha256;
    const observed = witnessEvidence.parameters;
    if (
      proof.runId === null ||
      observed.run_id !== proof.runId ||
      observed.artifact_sha256 !== artifactSha256 ||
      observed.conditions_sha256 !== receipt.conditions_sha256
    )
      return err("run-witness-scope-mismatch");
  }
  return ok(null);
};

const isObservedRuntimeCheckpoint = (
  evidence: Evidence,
  checkpointId: string,
): boolean => {
  const parameters = evidence.parameters;
  const result = evidence.normalized_result;
  return (
    evidence.predicate_type === "rea.runtime-witness" &&
    evidence.operation === "observe_checkpoint" &&
    parameters.checkpoint_id === checkpointId &&
    isRecord(result) &&
    result.observed === true &&
    evidenceSupportsOriginalAuthority(evidence, "runtime")
  );
};

/** Check that Evidence observes the original at the required boundary. */
export const evidenceSupportsOriginalAuthority = (
  evidence: Evidence,
  authority: OriginalAuthority,
): boolean => {
  if (evidence.confidence !== "observed") return false;
  if (authority === "static") return evidence.authority === "shipped-artifact";
  if (authority === "runtime")
    return ["controlled-replay", "external-service"].includes(
      evidence.authority,
    );
  if (authority === "process")
    return (
      evidence.authority === "controlled-replay" &&
      parseProcessCaptureEvidence(evidence).ok
    );
  return evidence.authority === "external-service";
};

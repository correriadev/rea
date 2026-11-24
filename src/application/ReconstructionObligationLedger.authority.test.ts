import { unknownTarget } from "../domain/targetIdentity.js";
import { describe, expect, it } from "vitest";
import { reconstructionProofApplicabilityCases } from "../../tests/fixtures/reconstructionProofApplicability.js";
import { createEvidenceBundle } from "../domain/evidenceBundle.js";

import {
  boundProofEvidence,
  build,
  originalCases,
  processEvidence,
  proofEvidence,
  request,
  resolveRequest,
  reviewedObligation,
  readyReviewedLedgerRequest,
} from "./ReconstructionObligationLedger.fixture.js";
import { createEvidence, evidenceSubjectInput } from "../domain/evidence.js";
import type { ReviewedReconstructionObligation } from "../domain/reconstructionObligationLedgerSchemas.js";
import { deriveReconstructionObligationCandidates } from "./ReconstructionObligationCandidates.js";
import { evaluateReconstructionObligationLedger } from "./ReconstructionObligationLedgerEvaluation.js";

describe("selected reconstruction fixture outcomes", () => {
  it.each(reconstructionProofApplicabilityCases())(
    "$name",
    ({ input, status, codes }) => {
      const ledger = build(input);
      expect(ledger.status).toBe(status);
      expect(ledger.obligations[0]?.status).toBe(
        status === "ready" ? "verified" : "implemented",
      );
      expect(
        ledger.obligations[0]?.diagnostics.map(({ code }) => code).sort(),
      ).toEqual([...codes].sort());
      for (const fixture of input.manifest.bindings[0]!.fixtures)
        for (const evidenceId of fixture.evidence_ids)
          expect(ledger.evidence_links).toContain(evidenceId);
      expect(ledger.summary.required_open).toBe(status === "ready" ? 0 : 1);
    },
  );
});

const registerOriginalProcessAuthorityCases = (): void => {
  it.each([
    {
      kind: "controlled capture",
      defect: null,
      state: "observed",
      qualifies: true,
    },
    {
      kind: "static authority",
      defect: "authority",
      state: "candidate",
      qualifies: false,
    },
    {
      kind: "foreign provider",
      defect: "provider",
      state: "reviewed",
      qualifies: false,
    },
    {
      kind: "malformed capture",
      defect: "payload",
      state: "reviewed",
      qualifies: false,
    },
  ] as const)(
    "qualifies original process authority for $kind",
    ({ defect, state, qualifies }) => {
      const capture = processEvidence();
      const original = createEvidence(
        evidenceSubjectInput(capture.subject),
        defect === "provider"
          ? { id: "foreign", name: "Foreign observer", version: "1" }
          : capture.provider,
        {
          predicateType: capture.predicate_type,
          operation: capture.operation,
          parameters: {},
          result: defect === "payload" ? {} : capture.normalized_result,
          confidence: "observed",
          authority:
            defect === "authority" ? "shipped-artifact" : "controlled-replay",
        },
      );
      const reviewed = {
        ...reviewedObligation("obl.reviewed.process", original.evidence_id),
        required_original_authority: "process" as const,
      };
      const result = build(
        request([original], {
          reviewed_obligations: [reviewed],
          manifest: {
            bindings: [
              {
                obligation_id: reviewed.obligation_id,
                owner: {
                  module_path: "src/processOwner.ts",
                  symbol: "runProcess",
                  owner_sha256: "5".repeat(64),
                },
                parser_type: null,
                original_cases: [
                  {
                    kind: "positive",
                    evidence_id: original.evidence_id,
                    location: "/normalized_result/exit",
                  },
                ],
                fixtures: [],
                verifier: null,
              },
            ],
            contradictions: [],
          },
        }),
      );
      const obligation = result.obligations.find(
        ({ obligation_id }) => obligation_id === reviewed.obligation_id,
      );
      expect(obligation).toBeDefined();
      const diagnostics = new Set(
        obligation?.diagnostics.map(({ code }) => code),
      );
      expect(diagnostics.has("static-only")).toBe(!qualifies);
      expect(diagnostics.has("weak-original-case-authority")).toBe(!qualifies);
      expect(obligation?.authority_references).toEqual([
        {
          evidence_id: original.evidence_id,
          authority: original.authority,
          state,
          location: `/evidence/${original.evidence_id}`,
        },
      ]);
    },
  );
};

describe("reconstruction obligation ledger", () => {
  registerOriginalProcessAuthorityCases();

  it("does not authenticate packaged-process proof with generic replay evidence", () => {
    const capture = processEvidence();
    const proof = proofEvidence("generic-packaged");
    const initial = build(request([capture, proof]));
    const obligation = initial.obligations[0];
    if (obligation === undefined)
      throw new Error("Expected process obligation");
    const result = build(
      request([capture, proof], {
        manifest: {
          bindings: [
            {
              obligation_id: obligation.obligation_id,
              owner: {
                module_path: "src/processOwner.ts",
                symbol: "runProcess",
                owner_sha256: "5".repeat(64),
              },
              parser_type: null,
              original_cases: originalCases(obligation, capture.evidence_id),
              fixtures: obligation.required_case_kinds.map((caseKind) => ({
                fixture_id: `packaged.${caseKind}`,
                case_kind: caseKind,
                authority: "packaged-process",
                evidence_ids: [proof.evidence_id],
              })),
              verifier: {
                verifier_id: "verifier.packaged",
                claim_id: "claim.process",
                command: "npm run verify:package -- process",
                authority: "packaged-process",
                status: "pass",
                result_evidence_id: proof.evidence_id,
                enumerated_obligation_ids: [obligation.obligation_id],
                nondeterminism: {
                  mode: "partial-order",
                  specification: "Fixture scheduling is partially ordered.",
                },
              },
            },
          ],
          contradictions: [],
        },
      }),
    );

    expect(result.obligations[0]?.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "inapplicable-fixture-proof",
        "inapplicable-verifier-proof",
      ]),
    );
  });

  it("propagates an open dependency through the full obligation chain", () => {
    const ids = ["obl.chain.a", "obl.chain.b", "obl.chain.c"] as const;
    const evidence = boundProofEvidence(
      "fixture-chain",
      {
        bindings: ids.map((id) => ({
          obligation_id: id,
          obligation_version: 1,
          owner_sha256: "6".repeat(64),
          fixtures: [
            {
              fixture_id: `fixture.${id}`,
              case_kind: "positive" as const,
              passed: true,
            },
          ],
          verifiers: [
            {
              verifier_id: `verifier.${id}`,
              claim_id: `claim.${id}`,
              passed: true,
            },
          ],
        })),
      },
      "shipped-artifact",
    );
    const reviewed = ids.map((id, index) => ({
      ...reviewedObligation(id, evidence.evidence_id),
      dependency_obligation_ids:
        index === 0 ? [ids[1]] : index === 1 ? [ids[2]] : ["obl.chain.missing"],
    }));
    const bindings = reviewed.map((obligation) => ({
      obligation_id: obligation.obligation_id,
      owner: {
        module_path: `src/${obligation.obligation_id}.ts`,
        symbol: "verify",
        owner_sha256: "6".repeat(64),
      },
      parser_type: null,
      original_cases: [
        {
          kind: "positive" as const,
          evidence_id: evidence.evidence_id,
          location: "/fixture/positive",
        },
      ],
      fixtures: [
        {
          fixture_id: `fixture.${obligation.obligation_id}`,
          case_kind: "positive" as const,
          authority: "unit" as const,
          evidence_ids: [evidence.evidence_id],
        },
      ],
      verifier: {
        verifier_id: `verifier.${obligation.obligation_id}`,
        claim_id: `claim.${obligation.obligation_id}`,
        command: "npm test -- fixture-chain",
        authority: "unit" as const,
        status: "pass" as const,
        result_evidence_id: evidence.evidence_id,
        enumerated_obligation_ids: [obligation.obligation_id],
        nondeterminism: {
          mode: "total-order" as const,
          specification: "Fixture execution is ordered.",
        },
      },
    }));
    const result = build(
      request([evidence], {
        reviewed_obligations: reviewed,
        manifest: { bindings, contradictions: [] },
      }),
    );

    expect(result.obligations.map(({ status }) => status)).toEqual([
      "blocked",
      "blocked",
      "blocked",
    ]);
    expect(
      result.obligations.map(({ diagnostics }) =>
        diagnostics.map(({ code }) => code),
      ),
    ).toEqual([
      ["dependency-open"],
      ["dependency-open"],
      ["dependency-missing"],
    ]);
  });
});

describe("reconstruction obligation ledger fail-closed behavior", () => {
  it("requires a parser, schema and domain type for a reviewed parser boundary", () => {
    const input = readyReviewedLedgerRequest();
    input.reviewed_obligations[0]!.requires_parser_type = true;
    const missing = build(input);
    expect(missing.status).toBe("open");
    expect(missing.obligations[0]?.diagnostics.map(({ code }) => code)).toEqual(
      ["missing-parser-type"],
    );
    input.manifest.bindings[0]!.parser_type = {
      parser: "parseRequest",
      schema: "requestSchema",
      domain_type: "Request",
    };
    expect(build(input).status).toBe("ready");
  });

  it("fails closed on ambiguous ownership and contradiction", () => {
    const original = createEvidence(
      unknownTarget("not-observed"),
      { id: "external", name: "External protocol observer", version: "1" },
      {
        predicateType: "rea.protocol-observation",
        operation: "observe_protocol",
        parameters: {},
        result: { status: 200 },
        confidence: "observed",
        authority: "external-service",
      },
    );
    const proof = proofEvidence("protocol");
    const reviewed: ReviewedReconstructionObligation = {
      ...reviewedObligation("obl.protocol", original.evidence_id),
      application_layer: "protocol" as const,
      family: "json-rpc",
      required_original_authority: "external" as const,
      required_fixture_authority: "protocol" as const,
      required_verifier_authority: "protocol" as const,
      requires_parser_type: true,
      required_case_kinds: ["positive", "negative", "malformed"],
    };
    const binding = {
      obligation_id: reviewed.obligation_id,
      owner: {
        module_path: "src/protocol.ts",
        symbol: "handleRequest",
        owner_sha256: "3".repeat(64),
      },
      parser_type: null,
      original_cases: reviewed.required_case_kinds.map((caseKind) => ({
        kind: caseKind,
        evidence_id: original.evidence_id,
        location: `/protocol/${caseKind}`,
      })),
      fixtures: [
        {
          fixture_id: "fixture.positive",
          case_kind: "positive" as const,
          authority: "unit" as const,
          evidence_ids: [proof.evidence_id],
        },
      ],
      verifier: null,
    };
    const result = build(
      request([original, proof], {
        reviewed_obligations: [reviewed],
        manifest: {
          bindings: [binding, binding],
          contradictions: [
            {
              obligation_id: reviewed.obligation_id,
              evidence_ids: [original.evidence_id, proof.evidence_id],
            },
          ],
        },
      }),
    );

    expect(result.status).toBe("failed");
    expect(result.obligations[0]?.status).toBe("contradicted");
    expect(result.obligations[0]?.diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["ambiguous-owner", "contradiction"]),
    );
    expect(result.reports.contradicted_obligation_ids).toEqual([
      reviewed.obligation_id,
    ]);
  });
});

const runId = "settings-run-1";
const expectedRun = {
  baseline_owner_sha256: "b".repeat(64),
  candidate_owner_sha256: "1".repeat(64),
  conditions_sha256: "c".repeat(64),
  required_witnesses: ["checkpoint.startup"],
};

const runCases = [
  {
    name: "legacy proof remains readable without run requirements",
    optIn: false,
    receipt: "legacy",
    reportFailure: false,
    expectedStatus: "ready",
    reason: null,
  },
  {
    name: "legacy proof cannot satisfy opted-in run requirements",
    optIn: true,
    receipt: "legacy",
    reportFailure: false,
    expectedStatus: "open",
    reason: "run-requirements-missing",
  },
  {
    name: "matching run receipt and retained witness satisfy the requirement",
    optIn: true,
    receipt: "matching",
    reportFailure: false,
    expectedStatus: "ready",
    reason: null,
  },
  {
    name: "stale build receipt with a reported failure stays inapplicable",
    optIn: true,
    receipt: "wrong-build",
    reportFailure: true,
    expectedStatus: "open",
    reason: "run-build-mismatch",
  },
  {
    name: "receipt with different normalized conditions stays inapplicable",
    optIn: true,
    receipt: "wrong-conditions",
    reportFailure: false,
    expectedStatus: "open",
    reason: "run-conditions-mismatch",
  },
  {
    name: "receipt missing a required checkpoint stays open",
    optIn: true,
    receipt: "missing-witness",
    reportFailure: false,
    expectedStatus: "open",
    reason: "run-witness-missing",
  },
  {
    name: "receipt cannot use a witness absent from its evidence links",
    optIn: true,
    receipt: "unlinked-witness",
    reportFailure: false,
    expectedStatus: "open",
    reason: "run-witness-unlinked",
  },
  {
    name: "receipt with incomplete cleanup stays open",
    optIn: true,
    receipt: "incomplete-cleanup",
    reportFailure: false,
    expectedStatus: "open",
    reason: "run-cleanup-incomplete",
  },
  ...(
    [
      "wrong-witness-run",
      "wrong-witness-build",
      "wrong-witness-conditions",
      "unbound-witness",
    ] as const
  ).map((receipt) => ({
    name: `${receipt} cannot close a governed obligation`,
    optIn: true,
    receipt,
    reportFailure: false,
    expectedStatus: "open",
    reason: "run-witness-scope-mismatch",
  })),
  {
    name: "a baseline checkpoint can explicitly require the baseline build",
    optIn: true,
    receipt: "baseline-witness",
    reportFailure: false,
    expectedStatus: "ready",
    reason: null,
  },
] as const;

type RunCase = (typeof runCases)[number];

const createRunFixture = (receipt: RunCase["receipt"]) => {
  const witness = createEvidence(
    unknownTarget("not-observed"),
    { id: "runtime-witness", name: "Runtime witness", version: "1" },
    {
      predicateType: "rea.runtime-witness",
      operation: "observe_checkpoint",
      parameters: {
        checkpoint_id: "checkpoint.startup",
        ...(receipt === "unbound-witness"
          ? {}
          : {
              run_id:
                receipt === "wrong-witness-run" ? "settings-run-2" : runId,
              artifact_sha256:
                receipt === "wrong-witness-build" ||
                receipt === "baseline-witness"
                  ? expectedRun.baseline_owner_sha256
                  : expectedRun.candidate_owner_sha256,
              conditions_sha256:
                receipt === "wrong-witness-conditions"
                  ? "f".repeat(64)
                  : expectedRun.conditions_sha256,
            }),
      },
      result: { observed: true },
      confidence: "observed",
      authority: "controlled-replay",
    },
  );
  const run =
    receipt === "legacy"
      ? undefined
      : {
          baseline_owner_sha256:
            receipt === "wrong-build"
              ? "d".repeat(64)
              : expectedRun.baseline_owner_sha256,
          candidate_owner_sha256: expectedRun.candidate_owner_sha256,
          conditions_sha256:
            receipt === "wrong-conditions"
              ? "e".repeat(64)
              : expectedRun.conditions_sha256,
          cleanup: receipt === "incomplete-cleanup" ? "incomplete" : "complete",
          witnesses:
            receipt === "missing-witness"
              ? []
              : [
                  {
                    checkpoint_id: "checkpoint.startup",
                    evidence_id: witness.evidence_id,
                  },
                ],
        };
  return { witness, run };
};

describe("opt-in reconstruction run requirements", () => {
  it.each(runCases)(
    "$name",
    ({ optIn, receipt, reportFailure, expectedStatus, reason }) => {
      const input = readyReviewedLedgerRequest();
      const oldProofId =
        input.manifest.bindings[0]?.verifier?.result_evidence_id;
      if (oldProofId === undefined)
        throw new Error("Expected a reviewed proof binding");
      const oldProof = input.evidence_bundle.records.find(
        ({ evidence_id }) => evidence_id === oldProofId,
      );
      if (oldProof === undefined)
        throw new Error("Expected the reviewed proof Evidence");

      const { witness, run } = createRunFixture(receipt);
      const proof =
        run === undefined
          ? oldProof
          : createEvidence(
              evidenceSubjectInput(oldProof.subject),
              oldProof.provider,
              {
                predicateType: oldProof.predicate_type,
                operation: oldProof.operation,
                parameters: { ...oldProof.parameters, run_id: runId },
                result: {
                  ...(oldProof.normalized_result as unknown as Record<
                    string,
                    unknown
                  >),
                  bindings: (
                    oldProof.normalized_result as unknown as {
                      bindings: readonly Record<string, unknown>[];
                    }
                  ).bindings.map((binding) => ({
                    ...binding,
                    fixtures: (
                      binding.fixtures as readonly Record<string, unknown>[]
                    ).map((fixture) => ({
                      ...fixture,
                      passed: !reportFailure,
                    })),
                    verifiers: (
                      binding.verifiers as readonly Record<string, unknown>[]
                    ).map((verifier) => ({
                      ...verifier,
                      passed: !reportFailure,
                    })),
                    ...(run === undefined ? {} : { run }),
                  })),
                },
                confidence: "observed",
                authority: oldProof.authority,
                evidenceLinks:
                  receipt === "unlinked-witness" ||
                  receipt === "missing-witness"
                    ? []
                    : [witness.evidence_id],
              },
            );
      const records = input.evidence_bundle.records.filter(
        ({ evidence_id }) => evidence_id !== oldProofId,
      );
      const requestWithRunEvidence = {
        ...input,
        evidence_bundle: createEvidenceBundle([
          ...records,
          ...(run === undefined || receipt === "missing-witness"
            ? []
            : [witness]),
          proof,
        ]),
        manifest: {
          ...input.manifest,
          bindings: input.manifest.bindings.map((binding) => ({
            ...binding,
            fixtures: binding.fixtures.map((fixture) => ({
              ...fixture,
              evidence_ids: fixture.evidence_ids.map((id) =>
                id === oldProofId ? proof.evidence_id : id,
              ),
            })),
            verifier:
              binding.verifier === null
                ? null
                : {
                    ...binding.verifier,
                    result_evidence_id: proof.evidence_id,
                  },
          })),
        },
      };
      const resolved = resolveRequest(requestWithRunEvidence);
      const candidateSet = deriveReconstructionObligationCandidates(resolved);
      const candidates = candidateSet.candidates.map((candidate) => ({
        ...candidate,
        ...(optIn
          ? {
              run_requirements:
                receipt === "baseline-witness"
                  ? {
                      ...expectedRun,
                      required_witnesses: [
                        {
                          checkpoint_id: "checkpoint.startup",
                          build_role: "baseline" as const,
                        },
                      ],
                    }
                  : expectedRun,
            }
          : {}),
      }));
      const ledger = evaluateReconstructionObligationLedger({
        candidates,
        sources: resolved.sources,
        manifest: resolved.manifest,
        generationLimitations: candidateSet.limitations,
      });
      const obligation = ledger.obligations[0];

      expect(ledger.status).toBe(expectedStatus);
      if (reason === null) {
        expect(obligation?.status).toBe("verified");
        expect(obligation?.diagnostics).toEqual([]);
      } else {
        expect(obligation?.status).toBe("implemented");
        expect(
          obligation?.diagnostics.some(
            ({ code, detail }) =>
              [
                "inapplicable-fixture-proof",
                "inapplicable-verifier-proof",
              ].includes(code) && detail.includes(reason),
          ),
        ).toBe(true);
        if (reportFailure)
          for (const code of obligation?.diagnostics.map(({ code }) => code) ??
            [])
            expect(["fixture-failed", "verifier-failed"]).not.toContain(code);
      }
    },
  );
});

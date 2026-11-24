import { expect, it, vi } from "vitest";
import { createEvidence } from "../../domain/evidence.js";
import { REA_WORKFLOW_PROVIDER } from "../../domain/investigationProviders.js";
import { InvestigationRecords } from "./InvestigationRecords.js";
import {
  recordUnknownInputSchema,
  updateUnknownInputSchema,
} from "../../domain/residualUnknown.js";
import { unknownTarget } from "../../domain/targetIdentity.js";
import { updateInvestigationGraph } from "./InvestigationGraphService.js";

const target = {
  path: "C:/sample.bin",
  sha256: "a".repeat(64),
  format: "raw-binary" as const,
};
const source = (operation: string, digest = "a") =>
  createEvidence(
    { ...target, sha256: digest.repeat(64) },
    REA_WORKFLOW_PROVIDER,
    {
      operation,
      parameters: {},
      result: { operation },
      confidence: "observed",
      authority: "shipped-artifact",
    },
  );
const emptyPatch = () => ({
  components: [],
  scenarios: [],
  variants: [],
  relations: [],
  claims: [],
  gaps: [],
  coverage: { status: "unknown" as const, limitations: ["Partial evidence"] },
});

const prepareRevisionHistory = () => {
  const records = new InvestigationRecords();
  const first = source("inspect_binary_layout");
  const second = source("inspect_byte_entropy");
  const wrong = source("inspect_byte_entropy", "b");
  expect(records.recordEvidence(second).ok).toBe(true);
  const lookup = vi.spyOn(records, "evidenceForAnalysis");
  const initial = updateInvestigationGraph(
    {
      scope_id: "scope",
      target_revision_id: "r1",
      sources: [
        first,
        { kind: "retained-evidence", evidence_id: second.evidence_id },
      ],
      patch: {
        ...emptyPatch(),
        scenarios: [{ id: "scenario", name: "Login" }],
      },
    },
    records,
  );
  expect(initial.ok).toBe(true);
  if (!initial.ok) throw initial.error;
  expect(records.recordEvidence(first).ok).toBe(true);
  expect(records.recordEvidence(initial.value.evidence).ok).toBe(true);
  const original = structuredClone(initial.value.evidence);
  const patch = {
    ...emptyPatch(),
    claims: [
      {
        id: "claim",
        subject: { kind: "scenario", id: "scenario" },
        target_revision_id: "r1",
        variant_id: null,
        statement: "A login occurs",
        confidence: "observed",
        rationale: null,
        sources: [
          {
            evidence_id: second.evidence_id,
            role: "supporting",
            target_revision_id: "r1",
            identity_evidence_id: first.evidence_id,
          },
        ],
      },
    ],
  };
  const request = {
    scope_id: "scope",
    target_revision_id: "r1",
    previous: {
      kind: "retained-evidence",
      evidence_id: initial.value.evidence.evidence_id,
    },
    sources: [],
    patch,
  };
  return {
    records,
    first,
    second,
    wrong,
    lookup,
    initial,
    original,
    patch,
    request,
  };
};

it("composes immutable deterministic history", () => {
  const { records, first, second, lookup, original, patch, request } =
    prepareRevisionHistory();
  const child = updateInvestigationGraph(request, records);
  const retry = updateInvestigationGraph(request, records);
  const sibling = updateInvestigationGraph(
    {
      ...request,
      patch: {
        ...patch,
        claims: [{ ...patch.claims[0], statement: "Another outcome" }],
      },
    },
    records,
  );
  expect(child.ok && retry.ok && sibling.ok).toBe(true);
  if (!child.ok || !retry.ok || !sibling.ok) return;
  expect(Object.isFrozen(child.value.evidence)).toBe(true);
  expect(Object.isFrozen(child.value.evidence.normalized_result)).toBe(true);
  expect(child.value.evidence.evidence_id).toBe(
    retry.value.evidence.evidence_id,
  );
  expect(sibling.value.evidence.evidence_id).not.toBe(
    child.value.evidence.evidence_id,
  );
  expect(child.value.evidence.normalized_result).toEqual({
    format_version: 1,
    scope_id: "scope",
    target_revision_id: "r1",
    previous_evidence_id: original.evidence_id,
    source_evidence_ids: [first.evidence_id, second.evidence_id].sort(),
    components: [],
    scenarios: [{ id: "scenario", name: "Login" }],
    variants: [],
    relations: [],
    claims: [{ ...patch.claims[0], applicability: "supported" }],
    gaps: [],
    coverage: patch.coverage,
  });
  expect(child.value.evidence.evidence_links).toEqual(
    expect.arrayContaining([
      first.evidence_id,
      second.evidence_id,
      original.evidence_id,
    ]),
  );
  expect(lookup).toHaveBeenCalledWith(second.evidence_id);
});

it("rejects invalid links and cancellation without changing the parent", () => {
  const { first, wrong, records, request, patch, initial, original } =
    prepareRevisionHistory();
  const invalid = updateInvestigationGraph(
    {
      ...request,
      sources: [wrong],
      patch: {
        ...patch,
        claims: [
          {
            ...patch.claims[0],
            sources: [
              {
                ...patch.claims[0]!.sources[0],
                evidence_id: wrong.evidence_id,
              },
            ],
          },
        ],
      },
    },
    records,
  );
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(invalid.error._tag).toBe("AnalysisInputError");
  const foreign = updateInvestigationGraph(
    { ...request, scope_id: "other" },
    records,
  );
  expect(foreign.ok).toBe(false);
  if (!foreign.ok) expect(foreign.error._tag).toBe("AnalysisInputError");
  const missing = updateInvestigationGraph(
    {
      ...request,
      patch: {
        ...patch,
        gaps: [
          {
            id: "gap",
            subject: { kind: "scenario", id: "scenario" },
            question: "Why?",
            unknown: {
              unknown_id: `unk_${"c".repeat(64)}`,
              revision: 1,
              revision_digest: "d".repeat(64),
            },
            migration_checks: [],
          },
        ],
      },
    },
    records,
  );
  expect(missing.ok).toBe(false);
  if (!missing.ok) expect(missing.error._tag).toBe("AnalysisInputError");
  const malformed = updateInvestigationGraph(
    {
      ...request,
      sources: [{ ...first, normalized_result: { forged: true } }],
    },
    records,
  );
  expect(malformed.ok).toBe(false);
  const orphan = createEvidence(target, REA_WORKFLOW_PROVIDER, {
    operation: "partial",
    parameters: {},
    result: {},
    evidenceLinks: [`ev_${"e".repeat(64)}`],
  });
  expect(
    updateInvestigationGraph({ ...request, sources: [orphan] }, records).ok,
  ).toBe(false);
  const abort = new AbortController();
  const abortingReader = {
    evidenceForAnalysis: (id: string) => {
      abort.abort("stop");
      return records.evidenceForAnalysis(id);
    },
    immutableEvidenceBundle: () => records.immutableEvidenceBundle(),
  };
  const cancelled = updateInvestigationGraph(
    request,
    abortingReader,
    abort.signal,
  );
  expect(cancelled.ok).toBe(false);
  if (!cancelled.ok)
    expect(cancelled.error._tag).toBe("AnalysisCancelledError");
  expect(initial.value.evidence).toEqual(original);
});

it("keeps a claim unresolved when its identity is unavailable", () => {
  const { records, request, patch } = prepareRevisionHistory();
  const incomplete = createEvidence(
    unknownTarget("not-observed"),
    REA_WORKFLOW_PROVIDER,
    {
      operation: "partial",
      parameters: {},
      result: {},
      confidence: "observed",
      limitations: ["Identity unavailable"],
    },
  );
  const unresolved = updateInvestigationGraph(
    {
      ...request,
      sources: [incomplete],
      patch: {
        ...patch,
        claims: [
          {
            ...patch.claims[0],
            sources: [
              {
                ...patch.claims[0]!.sources[0],
                evidence_id: incomplete.evidence_id,
              },
            ],
          },
        ],
      },
    },
    records,
  );
  expect(unresolved.ok).toBe(true);
  if (unresolved.ok)
    expect(unresolved.value.evidence.normalized_result).toMatchObject({
      claims: [{ applicability: "unresolved" }],
    });
});

it("preserves a pinned Unknown through bundle recovery", () => {
  const { records, request, patch } = prepareRevisionHistory();
  const unknown = records.recordUnknown(
    recordUnknownInputSchema.parse({
      question: "Is login complete?",
      severity: "high",
      domain: "login",
      required_authority: null,
      required_confidence: "observed",
      required_environment: null,
      recommended_probes: [],
      relationships: [],
    }),
  );
  expect(unknown.ok).toBe(true);
  if (unknown.ok) {
    const next = records.updateUnknown(
      updateUnknownInputSchema.parse({
        unknown_id: unknown.value.unknown_id,
        expected_revision: unknown.value.revision,
        status: "investigating",
        severity: unknown.value.severity,
        supporting_evidence_ids: unknown.value.supporting_evidence_ids,
        contradicting_evidence_ids: unknown.value.contradicting_evidence_ids,
        required_authority: unknown.value.required_authority,
        required_confidence: unknown.value.required_confidence,
        required_environment: unknown.value.required_environment,
        recommended_probes: [],
        relationships: [],
        resolution: null,
      }),
    );
    expect(next.ok).toBe(true);
    const pinned = updateInvestigationGraph(
      {
        ...request,
        patch: {
          ...patch,
          gaps: [
            {
              id: "gap",
              subject: { kind: "scenario", id: "scenario" },
              question: "Is login complete?",
              unknown: {
                unknown_id: unknown.value.unknown_id,
                revision: unknown.value.revision,
                revision_digest: unknown.value.revision_digest,
              },
              migration_checks: [],
            },
          ],
        },
      },
      records,
    );
    expect(pinned.ok).toBe(true);
    if (pinned.ok) {
      expect(pinned.value.evidence.evidence_links).toEqual(
        expect.arrayContaining(unknown.value.mutation_evidence_ids),
      );
      expect(records.recordEvidence(pinned.value.evidence).ok).toBe(true);
      const restored = new InvestigationRecords();
      expect(
        restored.mergeEvidenceBundle(records.exportEvidenceBundle()).ok,
      ).toBe(true);
      const reopened = updateInvestigationGraph(
        {
          ...request,
          previous: {
            kind: "retained-evidence",
            evidence_id: pinned.value.evidence.evidence_id,
          },
          patch: emptyPatch(),
        },
        restored,
      );
      expect(reopened.ok).toBe(true);
      if (reopened.ok)
        expect(reopened.value.evidence.normalized_result).toMatchObject({
          previous_evidence_id: pinned.value.evidence.evidence_id,
          gaps: [
            {
              unknown: {
                unknown_id: unknown.value.unknown_id,
                revision_digest: unknown.value.revision_digest,
              },
            },
          ],
        });
    }
  }
});

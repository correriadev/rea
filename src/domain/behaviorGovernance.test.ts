import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { createEvidence, parseEvidence, type Evidence } from "./evidence.js";
import { investigationGraphSchema } from "./investigationGraph.js";
import { REA_WORKFLOW_PROVIDER } from "./investigationProviders.js";
import { unknownTarget } from "./targetIdentity.js";

type GovernanceInput = {
  readonly kind: "source-system" | "migration";
  readonly scope_id: string;
  readonly revision_id: string;
  readonly previous: Evidence | null;
  readonly mapping_evidence: Evidence;
  readonly claim_id: string;
  readonly disposition: string;
  readonly reason:
    | { readonly status: "known"; readonly text: string }
    | { readonly status: "unknown" };
  readonly actor_claim: {
    readonly status: "declared";
    readonly value: string;
  };
  readonly origin_governance?: Evidence;
};

type GovernanceEvidence = Evidence<{
  readonly format_version: 1;
  readonly kind: "source-system" | "migration";
  readonly scope_id: string;
  readonly revision_id: string;
  readonly previous_evidence_id: string | null;
  readonly mapping_evidence_id: string;
  readonly claim_id: string;
  readonly disposition: string;
  readonly reason:
    | { readonly status: "known"; readonly text: string }
    | { readonly status: "unknown" };
  readonly actor_claim: {
    readonly status: "declared";
    readonly value: string;
  };
  readonly approval: { readonly status: "pending" };
  readonly origin_governance_evidence_id?: string;
}>;

type GovernanceResult =
  | { readonly ok: true; readonly value: GovernanceEvidence }
  | { readonly ok: false; readonly error: { readonly kind: string } };

type GovernanceModule = {
  createBehaviorGovernanceEvidence(input: GovernanceInput): GovernanceResult;
};

const loadGovernance = async (): Promise<GovernanceModule | undefined> => {
  const plannedSource = new URL("./behaviorGovernance.ts", import.meta.url);
  if (!existsSync(plannedSource)) return undefined;
  // Deliberately do not catch import failures: a present but broken module is
  // a real test failure, not the expected baseline RED.
  return (await import("./behaviorGovernance.js")) as GovernanceModule;
};

const graph = (scopeId = "settings", claimId = "save-fresh") =>
  investigationGraphSchema.parse({
    format_version: 1,
    scope_id: scopeId,
    target_revision_id: "mapping-r1",
    previous_evidence_id: null,
    source_evidence_ids: [],
    components: [],
    scenarios: [{ id: "settings", name: "Settings" }],
    variants: [],
    relations: [],
    claims: [
      {
        id: claimId,
        subject: { kind: "scenario", id: "settings" },
        target_revision_id: "mapping-r1",
        variant_id: null,
        statement: "Fresh saves preserve the setting",
        confidence: "observed",
        rationale: null,
        sources: [],
        applicability: "supported",
      },
    ],
    gaps: [],
    coverage: { status: "complete", limitations: [] },
  });

const mappingEvidence = (scopeId = "settings", claimId = "save-fresh") => {
  const result = graph(scopeId, claimId);
  return createEvidence(
    unknownTarget("derived-from-linked-evidence"),
    REA_WORKFLOW_PROVIDER,
    {
      predicateType: "rea.investigation-graph",
      operation: "update_investigation_graph",
      parameters: { scope_id: scopeId, target_revision_id: "mapping-r1" },
      result,
      confidence: "derived",
    },
  );
};

const sourceInput = (mapping: Evidence): GovernanceInput => ({
  kind: "source-system",
  scope_id: "settings",
  revision_id: "source-r1",
  previous: null,
  mapping_evidence: mapping,
  claim_id: "save-fresh",
  disposition: "confirmed",
  reason: { status: "unknown" },
  actor_claim: { status: "declared", value: "owner@example.test" },
});

it("creates canonical Evidence for an exact graph claim and retains unknown rationale as pending", async () => {
  const governance = await loadGovernance();
  const mapping = mappingEvidence();
  const input = sourceInput(mapping);
  const first = governance?.createBehaviorGovernanceEvidence(input);
  const repeated = governance?.createBehaviorGovernanceEvidence(input);

  expect(first).toMatchObject({
    ok: true,
    value: {
      evidence_id: expect.stringMatching(/^ev_[a-f0-9]{64}$/u),
      normalized_result: {
        format_version: 1,
        kind: "source-system",
        scope_id: "settings",
        revision_id: "source-r1",
        previous_evidence_id: null,
        mapping_evidence_id: mapping.evidence_id,
        claim_id: "save-fresh",
        disposition: "confirmed",
        reason: { status: "unknown" },
        actor_claim: { status: "declared", value: "owner@example.test" },
        approval: { status: "pending" },
      },
    },
  });
  if (first?.ok && repeated?.ok) {
    expect(repeated.value.evidence_id).toBe(first.value.evidence_id);
    expect(parseEvidence(first.value)).toEqual(first.value);
  }
});

it("keeps source and migration histories separate and accepts only an explicit same-kind predecessor", async () => {
  const governance = await loadGovernance();
  if (governance === undefined) {
    expect(undefined).toMatchObject({
      normalized_result: { kind: "source-system" },
    });
    return;
  }

  const mapping = mappingEvidence();
  const sourceResult = governance.createBehaviorGovernanceEvidence(
    sourceInput(mapping),
  );
  expect(sourceResult.ok).toBe(true);
  if (!sourceResult.ok) return;
  const source = sourceResult.value;
  const nextSourceResult = governance.createBehaviorGovernanceEvidence({
    ...sourceInput(mapping),
    revision_id: "source-r2",
    previous: source,
  });
  const migrationResult = governance.createBehaviorGovernanceEvidence({
    kind: "migration",
    scope_id: "settings",
    revision_id: "migration-r1",
    previous: null,
    mapping_evidence: mapping,
    claim_id: "save-fresh",
    disposition: "preserve",
    reason: { status: "known", text: "Preserve the observed behavior" },
    actor_claim: { status: "declared", value: "reviewer@example.test" },
    origin_governance: source,
  });
  expect(nextSourceResult.ok).toBe(true);
  expect(migrationResult.ok).toBe(true);
  if (!nextSourceResult.ok || !migrationResult.ok) return;
  const nextSource = nextSourceResult.value;
  const migration = migrationResult.value;

  expect(nextSource.normalized_result).toMatchObject({
    kind: "source-system",
    scope_id: "settings",
    previous_evidence_id: source.evidence_id,
  });
  expect(migration.normalized_result).toMatchObject({
    kind: "migration",
    scope_id: "settings",
    previous_evidence_id: null,
    origin_governance_evidence_id: source.evidence_id,
    reason: { status: "known", text: "Preserve the observed behavior" },
  });
  expect(migration.evidence_id).not.toBe(source.evidence_id);
  const wrongPredecessor = governance.createBehaviorGovernanceEvidence({
    kind: "migration",
    scope_id: "settings",
    revision_id: "migration-r2",
    previous: source,
    mapping_evidence: mapping,
    claim_id: "save-fresh",
    disposition: "preserve",
    reason: { status: "unknown" },
    actor_claim: { status: "declared", value: "reviewer@example.test" },
  });
  expect(wrongPredecessor.ok).toBe(false);
});

it("rejects selectors outside the graph scope and source records carrying migration origin", async () => {
  const governance = await loadGovernance();
  if (governance === undefined) {
    expect(undefined).toMatchObject({
      normalized_result: { kind: "source-system" },
    });
    return;
  }

  const mapping = mappingEvidence();
  const sourceResult = governance.createBehaviorGovernanceEvidence(
    sourceInput(mapping),
  );
  expect(sourceResult.ok).toBe(true);
  if (!sourceResult.ok) return;
  const wrongScope = governance.createBehaviorGovernanceEvidence({
    ...sourceInput(mapping),
    scope_id: "other-scope",
  });
  const missingClaim = governance.createBehaviorGovernanceEvidence({
    ...sourceInput(mapping),
    claim_id: "missing-claim",
  });
  const illegalOrigin = governance.createBehaviorGovernanceEvidence({
    ...sourceInput(mapping),
    origin_governance: sourceResult.value,
  });
  expect(wrongScope.ok).toBe(false);
  expect(missingClaim.ok).toBe(false);
  expect(illegalOrigin.ok).toBe(false);
  if (!wrongScope.ok && !missingClaim.ok)
    expect(wrongScope.error.kind).not.toBe(missingClaim.error.kind);
});

import { describe, expect, it } from "vitest";
import { analysisViewJavaScriptEvidence } from "../../../tests/fixtures/analysisView.js";
import { createEvidence, evidenceFileTarget } from "../../domain/evidence.js";
import { unknownTarget } from "../../domain/targetIdentity.js";
import { EvidenceLedger } from "../investigation/EvidenceLedger.js";
import { inspectAnalysisView } from "./AnalysisViewService.js";

const parent = analysisViewJavaScriptEvidence();
const witness = createEvidence(
  unknownTarget("derived-from-linked-evidence"),
  parent.provider,
  {
    operation: "inspect_electron_page",
    predicateType: parent.predicate_type,
    parameters: {},
    result: { reply: "wide" },
    confidence: "observed",
    authority: "controlled-replay",
  },
);
const scope = {
  build_sha256: evidenceFileTarget(parent)!.sha256,
  capture: "original",
  profile_directory: "/fresh/desk",
  process_identity: "pid:7:start:12",
};
const observation = (id: string, role: "entry" | "effect") => ({
  id,
  role,
  field: role,
  phase: "write",
  scope,
  status: "observed",
  value: { kind: "value", value: "wide" },
  source: { kind: "evidence", evidence_id: witness.evidence_id },
});
const request = {
  source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
  view: {
    kind: "legacy-journey",
    journey_id: "settings-layout",
    observations: [
      observation("ui", "entry"),
      observation("job", "entry"),
      observation("shared", "effect"),
      {
        id: "request",
        field: "requested",
        role: "action",
        phase: "write",
        scope,
        status: "unknown",
        reason: "Only the reply was recorded",
      },
    ],
    paths: [
      { entry: "ui", condition: "desktop", steps: ["ui", "shared"] },
      { entry: "job", condition: "scheduled", steps: ["job", "shared"] },
    ],
  },
};

describe("parent-backed legacy journey view", () => {
  it("reports an exact reply witness and preserves the unknown request", async () => {
    const result = await inspectAnalysisView(
      {
        ...request,
        view: {
          ...request.view,
          paths: [],
          observations: [
            {
              ...observation("reply", "effect"),
              field: "reply",
              source: {
                kind: "evidence",
                evidence_id: witness.evidence_id,
                member_path: ["reply"],
              },
            },
            request.view.observations.at(-1),
          ],
        },
      },
      (id) =>
        id === parent.evidence_id
          ? parent
          : id === witness.evidence_id
            ? witness
            : undefined,
    );
    if (!result.ok) throw result.error;
    expect(result.value.normalized_result).toMatchObject({
      observations: [
        {
          id: "reply",
          proof: "witness-value-matched",
          value: { kind: "value", value: "wide" },
        },
        { id: "request", status: "unknown" },
      ],
    });
  });
  it("restores the same scoped arrivals and field provenance from a portable bundle", async () => {
    const ledger = new EvidenceLedger();
    expect(ledger.record(parent).ok).toBe(true);
    expect(ledger.record(witness).ok).toBe(true);
    const restored = new EvidenceLedger();
    expect(restored.import(ledger.export()).ok).toBe(true);
    const initial = await inspectAnalysisView(request, (id) =>
      ledger.forAnalysis(id),
    );
    const rebuilt = await inspectAnalysisView(request, (id) =>
      restored.forAnalysis(id),
    );
    if (!initial.ok) throw initial.error;
    if (!rebuilt.ok) throw rebuilt.error;
    expect(rebuilt.value.evidence_id).toBe(initial.value.evidence_id);
    expect(rebuilt.value.evidence_links).toContain(witness.evidence_id);
    expect(rebuilt.value.normalized_result).toMatchObject({
      paths: [
        { entry: "ui", condition: "desktop", status: "declared" },
        { entry: "job", condition: "scheduled", status: "declared" },
      ],
      observations: expect.arrayContaining([
        expect.objectContaining({ id: "request", status: "unknown" }),
        expect.objectContaining({ id: "shared", proof: "caller-declared" }),
      ]),
    });
  });

  it("preserves missing-parent diagnostics without treating a missing witness as proof", async () => {
    const query = {
      ...request,
      view: {
        ...request.view,
        observations: [
          ...request.view.observations,
          {
            id: "derived-shared",
            role: "effect",
            field: "effect",
            phase: "write",
            scope,
            status: "derived",
            value: { kind: "value", value: "wide" },
            parents: ["shared"],
          },
        ],
      },
    };
    const result = await inspectAnalysisView(query, (id) =>
      id === parent.evidence_id ? parent : undefined,
    );
    if (!result.ok) throw result.error;
    expect(result.value.evidence_links).toEqual([parent.evidence_id]);
    expect(result.value.normalized_result).toMatchObject({
      paths: [{ status: "unresolved" }, { status: "unresolved" }],
      diagnostics: expect.arrayContaining([
        "Missing retained witness for shared",
      ]),
      observations: expect.arrayContaining([
        expect.objectContaining({ id: "shared", status: "unknown" }),
        expect.objectContaining({
          id: "derived-shared",
          status: "unknown",
          reason: "Observation parent shared is unavailable",
        }),
      ]),
    });
  });
});

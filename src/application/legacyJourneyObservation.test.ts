import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createEvidence, type Evidence } from "../domain/evidence.js";
import { unknownTarget } from "../domain/targetIdentity.js";
import { admitLegacyJourneyObservations } from "./legacyJourneyObservation.js";

const scope = {
  capture: "original",
  build_sha256: "a".repeat(64),
  profile_directory: "/profile",
  process_identity: "pid:1:start:10",
};
const evidence = { kind: "evidence", evidence_id: "ev-1" };
const lookup = (id: string): Evidence | undefined =>
  id === "ev-1" ? ({ evidence_id: id } as Evidence) : undefined;
const observed = (
  id: string,
  field: string,
  value: unknown,
  overrides = {},
) => ({
  id,
  field,
  role: "effect",
  phase: "after",
  scope,
  status: "observed",
  value: { kind: "value", value },
  source: evidence,
  ...overrides,
});

it("keeps unknown inputs, controls, absence, null, and contradictory witnesses distinct", () => {
  const input = [
    {
      id: "request",
      field: "requested",
      role: "action",
      phase: "action",
      scope,
      status: "unknown",
      reason: "not captured",
    },
    observed("reply", "reply", "wide"),
    observed("reply-2", "reply", "compact"),
    observed("file", "file", null, {
      value: { kind: "absent-file" },
      source: evidence,
    }),
    observed("member", "member", null, { value: { kind: "absent-member" } }),
    observed("null", "member", null),
    observed("control", "requested", "common-compact", {
      scope: { ...scope, capture: "control" },
    }),
  ];
  const result = admitLegacyJourneyObservations(input, lookup);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value).toEqual(input);
});

it("refuses derived joins across build, profile or capture, including shape-only replicates", () => {
  const parent = observed("parent", "reply", "wide");
  const derived = {
    id: "derived",
    field: "reply",
    role: "effect",
    phase: "after",
    scope,
    status: "derived",
    value: { kind: "value", value: "wide" },
    parents: ["parent"],
  };
  expect(admitLegacyJourneyObservations([parent, derived], lookup).ok).toBe(
    true,
  );
  for (const changed of [
    { build_sha256: "c".repeat(64) },
    { profile_directory: "/other" },
    { capture: "replicate" },
    { process_identity: "pid:1:start:11" },
  ]) {
    const result = admitLegacyJourneyObservations(
      [
        observed("parent", "reply", "wide"),
        { ...derived, scope: { ...scope, ...changed } },
      ],
      lookup,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisInputError");
  }
});

it("does not infer a request or reopened value from a handler reply", () => {
  const reply = observed("original-reply", "reply", "wide");
  const projected = {
    id: "projection",
    field: "reply",
    role: "effect",
    phase: "after",
    scope,
    status: "derived",
    value: { kind: "value", value: "wide" },
    parents: [reply.id],
  };
  for (const override of [
    { field: "requested", role: "action" },
    { field: "reopened", phase: "restart" },
    { value: { kind: "value", value: "compact" } },
  ])
    expect(
      admitLegacyJourneyObservations(
        [reply, { ...projected, ...override }],
        lookup,
      ).ok,
    ).toBe(false);

  const input = observed("explicit-request", "requested", "common-compact", {
    role: "action",
    phase: "submit",
    scope: { ...scope, capture: "control" },
  });
  expect(admitLegacyJourneyObservations([reply, input], lookup)).toEqual({
    ok: true,
    value: [reply, input],
  });
});

it("deduplicates identical records, refuses conflicting IDs, missing parents and malformed witnesses", () => {
  const item = observed("reply", "reply", "wide");
  expect(admitLegacyJourneyObservations([item, item], lookup)).toEqual({
    ok: true,
    value: [item],
  });
  for (const input of [
    [item, observed("reply", "reply", "compact")],
    [
      {
        id: "derived",
        field: "reply",
        role: "effect",
        phase: "after",
        scope,
        status: "derived",
        value: { kind: "value", value: "wide" },
        parents: ["missing"],
      },
    ],
    [observed("bad", "reply", "wide", { source: { kind: "evidence" } })],
    [
      observed("missing", "reply", "wide", {
        source: { kind: "evidence", evidence_id: "missing" },
      }),
    ],
  ]) {
    const result = admitLegacyJourneyObservations(input, lookup);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error._tag).toBe("AnalysisInputError");
  }
});
it("retains external bytes and rejects a mismatched digest", () => {
  const bytes = Buffer.from('{"mode":null}');
  const source = {
    kind: "external-state",
    path: "/profile/settings.json",
    file_identity: "file:1",
    bytes_base64: bytes.toString("base64"),
    bytes_sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const witness = observed("state", "mode", null, { source });
  expect(admitLegacyJourneyObservations([witness], lookup)).toEqual({
    ok: true,
    value: [witness],
  });
  expect(
    admitLegacyJourneyObservations(
      [
        observed("state", "mode", null, {
          source: { ...source, bytes_sha256: "0".repeat(64) },
        }),
      ],
      lookup,
    ).ok,
  ).toBe(false);
});

it("checks selected witness members and distinguishes null from a missing member", () => {
  const record = createEvidence(
    unknownTarget("derived-from-linked-evidence"),
    { id: "fixture", name: "Fixture", version: "1" },
    {
      operation: "inspect_electron_page",
      predicateType: "rea.fixture",
      parameters: {},
      result: { fields: { reply: "wide", layout: null } },
      confidence: "observed",
      authority: "controlled-replay",
    },
  );
  const witness = (member_path: string[]) => ({
    ...evidence,
    evidence_id: record.evidence_id,
    member_path,
  });
  const item = observed("reply", "reply", "wide", {
    source: witness(["fields", "reply"]),
  });
  const selector = (id: string) =>
    id === record.evidence_id ? record : undefined;
  expect(admitLegacyJourneyObservations([item], selector).ok).toBe(true);
  const absentMember = { kind: "absent-member" };
  for (const value of ["other", null]) {
    expect(
      admitLegacyJourneyObservations(
        [observed("reply", "reply", value, { source: item.source })],
        selector,
      ).ok,
    ).toBe(false);
  }
  expect(
    admitLegacyJourneyObservations(
      [
        observed("layout", "layout", null, {
          source: witness(["fields", "layout"]),
        }),
        observed("request", "requested", null, {
          source: witness(["fields", "requested"]),
          value: absentMember,
        }),
      ],
      selector,
    ).ok,
  ).toBe(true);
  expect(
    admitLegacyJourneyObservations(
      [
        observed("layout", "layout", null, {
          source: witness(["fields", "layout"]),
          value: absentMember,
        }),
      ],
      selector,
    ).ok,
  ).toBe(false);
});

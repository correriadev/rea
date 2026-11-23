import { z } from "zod";
import { sealAnalysisView } from "../../domain/analysisView/analysisView.js";
import type { AnalysisViewRequest } from "../../domain/analysisView/analysisViewRequest.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { evidenceFileTarget, type Evidence } from "../../domain/evidence.js";
import { equalJsonValues, jsonObjectSchema } from "../../domain/jsonValue.js";
import { err, ok } from "../../domain/result.js";
import type { EvidenceLookup } from "../EvidenceInputResolver.js";
import { admitLegacyJourneyObservations } from "../legacyJourneyObservation.js";
import { applicationFeatureTraceResultSchema } from "../../domain/javascript/javascriptFeatureTraceSchemas.js";
import { digestCanonicalValue } from "../../domain/canonicalDigest.js";
import { legacyJourneyReceiptSchema } from "../../domain/legacyJourneyProject.js";
import {
  admitLegacyJourneyReceipt,
  LEGACY_VERIFICATION_OPERATION,
  LEGACY_VERIFICATION_PREDICATE,
} from "../legacyJourneyVerification.js";

type Request = Extract<AnalysisViewRequest, { kind: "legacy-journey" }>;

export const projectLegacyJourneyView = (
  parent: Evidence,
  artifact: { readonly path: string; readonly sha256: string } | null,
  view: Request,
  lookup: EvidenceLookup | undefined,
) => {
  const build = evidenceFileTarget(parent);
  if (
    parent.operation !== "analyze_javascript_application" ||
    !build ||
    !artifact
  )
    return err(
      new AnalysisInputError("inspect_analysis_view", {
        userMessage:
          "Legacy journey view requires a JavaScript application build parent.",
      }),
    );

  const links = new Set([parent.evidence_id]);
  const diagnostics: string[] = [];
  const resolve = (id: string) =>
    id === parent.evidence_id ? parent : lookup?.(id);
  const admitted = admitLegacyJourneyObservations(
    view.observations,
    (id) => {
      const found = resolve(id);
      if (found?.evidence_id === id) links.add(id);
      return found;
    },
    (id) => diagnostics.push(`Missing retained witness for ${id}`),
  );
  if (!admitted.ok) return admitted;
  if (admitted.value.some((row) => row.scope.build_sha256 !== build.sha256))
    return err(
      new AnalysisInputError("inspect_analysis_view", {
        userMessage:
          "Observation build identity differs from the selected build.",
      }),
    );

  const rows = new Map(admitted.value.map((row) => [row.id, row]));
  const paths = view.paths.map((path) => {
    const [first] = path.steps;
    const start = first === undefined ? undefined : rows.get(first);
    const complete =
      start?.role === "entry" &&
      path.steps.every((id) => {
        const row = rows.get(id);
        return (
          row !== undefined &&
          row.status !== "unknown" &&
          equalJsonValues(start.scope, row.scope)
        );
      });
    return {
      ...path,
      status: complete ? ("declared" as const) : ("unresolved" as const),
    };
  });
  const staticTraces = (view.trace_evidence_ids ?? []).flatMap((id) => {
    const trace = resolve(id);
    if (
      !trace ||
      trace.operation !== "trace_application_feature" ||
      trace.predicate_type !== "rea.application-feature-trace" ||
      !trace.evidence_links.includes(parent.evidence_id)
    ) {
      diagnostics.push(`Missing or incompatible feature trace ${id}`);
      return [];
    }
    const data = applicationFeatureTraceResultSchema.safeParse(
      trace.normalized_result,
    );
    if (!data.success || data.data.source_evidence_id !== parent.evidence_id) {
      diagnostics.push(
        `Feature trace ${id} does not describe the selected build Evidence`,
      );
      return [];
    }
    links.add(id);
    return [
      {
        evidence_id: id,
        seed: data.data.seed,
        direction: data.data.direction,
        coverage: data.data.coverage.status,
        total_paths: data.data.paths.length,
        paths: data.data.paths.slice(0, 16),
      },
    ];
  });
  const observations = admitted.value.map((row) => {
    if (row.status === "unknown") return row;
    if (row.status === "derived")
      return { ...row, proof: "caller-declared" as const };
    const { member_path, ...input } = row.source;
    const proof =
      member_path === undefined ? "caller-declared" : "witness-value-matched";
    if (input.kind === "evidence")
      return {
        ...row,
        source: {
          ...input,
          ...(member_path === undefined ? {} : { member_path }),
        },
        proof,
      };
    const { bytes_base64: _bytes, ...source } = input;
    return {
      ...row,
      source: {
        ...source,
        ...(member_path === undefined ? {} : { member_path }),
      },
      proof,
    };
  });
  const verification = retainedVerification(
    parent,
    build.sha256,
    view,
    resolve,
  );
  if (verification !== undefined) {
    if (verification.ok) {
      links.add(verification.value.evidence_id);
      links.add(verification.value.base_view);
    } else diagnostics.push(verification.error);
  }
  return ok({
    links: [...links],
    result: sealAnalysisView({
      kind: "legacy-journey",
      parent_operation: "analyze_javascript_application",
      journey_id: view.journey_id,
      parent_evidence_id: parent.evidence_id,
      parent_digest: parent.evidence_id.slice(3),
      artifact,
      build_sha256: build.sha256,
      observations,
      ...(verification?.ok
        ? { verification: verification.value.projection }
        : {}),
      ...(view.trace_evidence_ids === undefined
        ? {}
        : { static_traces: staticTraces }),
      paths,
      diagnostics,
      coverage: {
        status: "complete-within-view",
        examined: observations.length,
        total: observations.length,
        next_offset: null,
        exhausted: true,
      },
      limitations: [
        ...parent.limitations,
        ...(observations.some(
          (row) => "proof" in row && row.proof === "witness-value-matched",
        )
          ? [
              "A matched witness member corroborates its JSON value. The caller supplies each field role, scope, and path condition.",
            ]
          : [
              "Field values and path conditions are caller declarations. Admission checks reference integrity and declared scope, not the witness payload's meaning.",
            ]),
        "Paths do not certify an upgrade or connect distinct captures.",
        ...(staticTraces.length === 0
          ? []
          : [
              "Feature traces expose at most 16 paths per seed. Follow the linked Evidence for complete paths and edge provenance.",
            ]),
      ],
      unknowns: observations.flatMap((row) =>
        row.status === "unknown" ? [row.id] : [],
      ),
    }),
  });
};

function retainedVerification(
  parent: Evidence,
  baseline: string,
  view: Request,
  lookup: EvidenceLookup,
) {
  const { verification_evidence_id: id, ...baseRequest } = view;
  if (id === undefined) return undefined;
  const proof = lookup(id);
  if (
    !proof ||
    proof.operation !== LEGACY_VERIFICATION_OPERATION ||
    proof.predicate_type !== LEGACY_VERIFICATION_PREDICATE
  )
    return err(`Missing or incompatible verification receipt ${id}`);
  const frame = z
    .object({
      journey_view: z.string(),
      candidate_sha256: z.string(),
    })
    .safeParse(proof.parameters);
  const linked = frame.success ? lookup(frame.data.journey_view) : undefined;
  const base = z
    .object({
      parent_evidence_id: z.string(),
      view: z.object({
        kind: z.literal("legacy-journey"),
        input_digest: z.string(),
      }),
    })
    .safeParse(linked?.parameters);
  if (
    !frame.success ||
    !linked ||
    !base.success ||
    linked.operation !== "inspect_analysis_view" ||
    !linked.evidence_links.includes(parent.evidence_id) ||
    !proof.evidence_links.includes(linked.evidence_id) ||
    base.data.parent_evidence_id !== parent.evidence_id ||
    base.data.view.input_digest !==
      digestCanonicalValue(baseRequest, "Legacy journey request")
  )
    return err(`Receipt ${id} is not linked to this exact base view`);
  const raw = legacyJourneyReceiptSchema.safeParse(proof.raw_result);
  if (!raw.success) return err(`Receipt ${id} has invalid observations`);
  const admitted = admitLegacyJourneyReceipt(raw.data, {
    journeyId: view.journey_id,
    baseline,
    candidate: frame.data.candidate_sha256,
    obligations: raw.data.cases,
  });
  if (!admitted.ok)
    return err(`Receipt ${id} does not match the selected builds and journey`);
  const receipt = admitted.value;
  return ok({
    evidence_id: id,
    base_view: linked.evidence_id,
    projection: {
      evidence_id: id,
      base_view_evidence_id: linked.evidence_id,
      candidate_sha256: receipt.candidate_sha256,
      cleanup: receipt.cleanup,
      cases: receipt.cases.map((record) => jsonObjectSchema.parse(record)),
      phases: receipt.phases.map((phase, index) =>
        jsonObjectSchema.parse({
          index,
          action: phase.action,
          build_sha256: phase.build_sha256,
          profile: phase.profile,
          profile_identity: phase.profile_identity,
          process_identity: phase.process_identity,
          requested:
            phase.action === "seed"
              ? {
                  kind: "value",
                  value: receipt.seed,
                  witness: "/raw_result/seed",
                }
              : {
                  kind: "unknown",
                  reason: "Read-only phase has no set request",
                },
          reply:
            phase.handler_reply === undefined
              ? { kind: "unknown", reason: "Handler reply was not recorded" }
              : {
                  kind: "value",
                  value: phase.handler_reply,
                  witness: `/raw_result/phases/${index}/handler_reply`,
                },
          stored: {
            ...phase.after,
            ...(phase.after.kind === "file"
              ? {
                  selected_value: phase.after.selected_value ?? {
                    kind: "unknown",
                    reason:
                      "No JSON state member was selected for this receipt",
                  },
                }
              : {}),
            witness: `/raw_result/phases/${index}/after`,
          },
          reopened:
            phase.action === "read-first"
              ? {
                  kind: "value",
                  value: phase.value,
                  witness: `/raw_result/phases/${index}/value`,
                }
              : {
                  kind: "unknown",
                  reason: "Seed phase did not reopen the profile",
                },
        }),
      ),
    },
  });
}

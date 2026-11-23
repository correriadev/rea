import { Readable } from "node:stream";
import type {
  LegacyJourneyProjectFile,
  LegacyJourneyProjectInput,
} from "../domain/legacyJourneyProject.js";
import {
  AnalysisInputError,
  AnalysisOutputError,
  cancelledBy,
} from "../domain/analysisErrorCore.js";
import { canonicalJson } from "../domain/comparisonSemantics.js";
import { digestCanonicalValue } from "../domain/canonicalDigest.js";
import { sha256Hex } from "../kernel/sha256Hex.js";
import {
  ArtifactResourceScope,
  bindArtifactFileCleanup,
  outputDirectoryAdmissionRefusal,
  SafeOutputTree,
  SafeOutputTreeCreationFailure,
} from "../resources/index.js";
import { LEGACY_PERSISTENCE_CASES } from "./ReconstructionObligationPolicies.js";
import { legacyJourneyRunner } from "./legacyJourneyVerification.js";
import { err, ok } from "../domain/result.js";

const operation = "export_legacy_journey_project";
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const html = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const csv = (value: string) => '"' + value.replaceAll('"', '""') + '"';

/** Render portable records before the output owner opens any destination. */
export const planLegacyJourneyProject = ({
  manifest,
  journey,
  evidence,
  ledger,
  query,
}: LegacyJourneyProjectInput) => {
  if (manifest.build.artifact_sha256 !== journey.build_sha256)
    return err(
      new AnalysisInputError(operation, {
        userMessage: "The journey and manifest must refer to the same build.",
      }),
    );
  const view = evidence.records.find(
    (record) =>
      record.operation === "inspect_analysis_view" &&
      (record.normalized_result as { view_digest?: unknown } | null)
        ?.view_digest === journey.view_digest &&
      canonicalJson(record.normalized_result, "Retained legacy journey") ===
        canonicalJson(journey, "Legacy journey export"),
  );
  const ids = new Set(evidence.records.map((record) => record.evidence_id));
  if (
    !view ||
    !ids.has(journey.parent_evidence_id) ||
    view.evidence_links.some((id) => !ids.has(id))
  )
    return err(
      new AnalysisInputError(operation, {
        userMessage:
          "The portable bundle must contain the journey and all of its native parents.",
      }),
    );
  if (query !== undefined) {
    const descriptor = (
      view.parameters as { view?: { input_digest?: unknown } }
    ).view;
    if (
      descriptor?.input_digest !==
      digestCanonicalValue(query, "Legacy journey request")
    )
      return err(
        new AnalysisInputError(operation, {
          userMessage:
            "The restore query does not match the retained view input.",
        }),
      );
  }
  const obligations = ledger.obligations.filter(
    (item) =>
      LEGACY_PERSISTENCE_CASES.some(({ family }) => family === item.family) &&
      item.authority_references.some(
        ({ evidence_id }) =>
          evidence_id ===
          (journey.verification?.base_view_evidence_id ?? view.evidence_id),
      ),
  );
  if (obligations.length !== LEGACY_PERSISTENCE_CASES.length)
    return err(
      new AnalysisInputError(operation, {
        userMessage:
          "The ledger must contain all persistence obligations for this journey.",
      }),
    );
  const rows = obligations.map((item) => [
    item.obligation_id,
    String(item.obligation_version),
    item.family,
    item.status,
    item.binding?.verifier?.status ?? "",
    item.status === "verified" ? "" : item.required_next_evidence.join(" "),
  ]);
  const files: LegacyJourneyProjectFile[] = [
    {
      path: "manifest.json",
      content: json({
        version: 1,
        characterization: manifest,
        journey: "journey.json",
        view_evidence_id: view.evidence_id,
        bundle: "evidence.json",
        ledger: "ledger.json",
        observations: "observation-plan.json",
        matrix: "migration-matrix.csv",
        report: "report.html",
        verifier: "verify.mjs",
        verification_plan: "verification-plan.json",
        ...(query === undefined ? {} : { restore_query: "journey-query.json" }),
      }),
    },
    { path: "journey.json", content: json(journey) },
    { path: "evidence.json", content: json(evidence) },
    { path: "ledger.json", content: json(ledger) },
    ...(query === undefined
      ? []
      : [
          {
            path: "journey-query.json",
            content: json({
              source: {
                kind: "retained-evidence",
                evidence_id: journey.parent_evidence_id,
              },
              view: query,
            }),
          },
        ]),
    { path: "verify.mjs", content: legacyJourneyRunner },
    {
      path: "verification-plan.json",
      content: json({
        version: 1,
        journey_id: journey.journey_id,
        build_sha256: journey.build_sha256,
        cases: obligations.map(
          ({ obligation_id, obligation_version, family }) => ({
            obligation_id,
            obligation_version,
            family,
          }),
        ),
      }),
    },
    {
      path: "README.md",
      content: [
        "# Legacy journey verification",
        "",
        "Run with Node.js 24 and a locally reviewed target driver.",
        "",
        "`node verify.mjs config.json result.json`",
        "",
        "Set `baseline`, `candidate` and `driver` to absolute local paths.",
        "Set `state_file` to a file basename relative to the launched profile.",
        "For text JSON state, set optional `state_value_path` to the exact member path as an array.",
        "Set `seed` to a known nondefault value and optionally set `timeout_ms`.",
        "",
        "The driver exports async `runPhase({ build, profile, action, seed, signal })`.",
        "It launches one process under the supplied disposable profile and owns exit and cleanup.",
        "For `read-first`, observe the first read before issuing a mutation and return `first_read`.",
        "For `seed`, write through the public entry point and return `value_after_seed`.",
        "Include `handler_reply` on a seed response when observed.",
        "Return a distinct launch `process_identity` and `settled: true` after process exit.",
        "The driver must stop its owned processes after cancellation and await their exit.",
        "",
        "The runner records independent state file digests before and after each phase.",
        "It reports clean start, same-build restart and in-place upgrade separately.",
        "It writes JSON, JUnit and HTML beside the caller-selected result path.",
        "It returns exit code 1 when any case fails or remains unknown.",
        "A retained profile root on cleanup failure is listed in the result for inspection.",
        "",
        "To evaluate the receipt in REA, use the exported `manifest.json` as `dossier_manifest_path`.",
        "Set `verification.candidate_sha256` to the independently selected candidate digest.",
        "Set `verification.receipt_path` to the absolute path of `result.json`, or put its contents in `verification.receipt`.",
        "Omit `export_directory` for inspection or choose a new directory for the updated dossier.",
        ...(query === undefined
          ? []
          : [
              "",
              "To restore the journey in a new MCP process, call `import_evidence_bundle` with `evidence.json`.",
              "Then pass `journey-query.json` as the arguments to `inspect_analysis_view`.",
              "The query carries scoped declarations and references. The bundle supplies the retained Evidence.",
            ]),
        "",
      ].join("\n"),
    },
    {
      path: "observation-plan.json",
      content: json(
        obligations.map((item) => ({
          obligation_id: item.obligation_id,
          version: item.obligation_version,
          case: item.family,
          original_cases: item.observed_cases,
          verifier_status: item.binding?.verifier?.status ?? null,
          required_next_evidence:
            item.status === "verified" ? [] : item.required_next_evidence,
        })),
      ),
    },
    {
      path: "migration-matrix.csv",
      content:
        "obligation_id,version,case,status,verifier_status,next_evidence\n" +
        rows.map((row) => row.map(csv).join(",")).join("\n") +
        "\n",
    },
    {
      path: "report.html",
      content:
        '<!doctype html><meta charset="utf-8">' +
        "<title>Legacy journey characterization</title>" +
        `<h1>${html(journey.journey_id)}</h1><ul>` +
        rows.map((row) => `<li>${html(row.join(" · "))}</li>`).join("") +
        '</ul><p><a href="migration-matrix.csv">Migration matrix</a></p>\n',
    },
  ];
  return ok(files);
};

/** Publish a portable dossier into a new directory owned by this operation. */
export const writeLegacyJourneyProject = async (
  input: LegacyJourneyProjectInput,
  directory: string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
) => {
  const planned = planLegacyJourneyProject(input);
  if (!planned.ok) throw planned.error;
  return resources.run(async () => {
    if (signal?.aborted) throw cancelledBy(operation, signal);
    let tree: SafeOutputTree | undefined;
    let receipt:
      | {
          directory: string;
          files: { path: string; sha256: string; bytes: number }[];
        }
      | undefined;
    let outcome: { kind: "completed" } | { kind: "failed"; cause: unknown };
    try {
      tree = await SafeOutputTree.create(directory);
      const files = [];
      // Write the manifest last so a reader never opens an incomplete file list.
      const manifest = planned.value.find(
        (file) => file.path === "manifest.json",
      )!;
      for (const file of [
        ...planned.value.filter((file) => file !== manifest),
        manifest,
      ]) {
        const data = Buffer.from(file.content);
        const checksum = { bytes: data.length, sha256: sha256Hex(data) };
        const written = await tree.write(
          file.path,
          Readable.from([data]),
          checksum,
          signal,
        );
        files.push({ path: written.relativePath, ...checksum });
      }
      receipt = { directory: tree.outputRoot, files };
      await tree.commit(signal);
      outcome = { kind: "completed" };
    } catch (cause) {
      if (cause instanceof SafeOutputTreeCreationFailure) tree = cause.tree;
      outcome = {
        kind: "failed",
        cause:
          signal?.aborted && !tree?.published
            ? cancelledBy(operation, signal)
            : cause,
      };
    }
    if (tree) {
      const cleanup = await resources.release({
        kind: "output-tree",
        resource: directory,
        tree,
      });
      if (cleanup.kind === "failed") {
        const failure = resources.cleanupFailure(outcome, [cleanup]);
        const error = new AnalysisOutputError(
          operation,
          tree.published
            ? `Dossier published to ${tree.outputRoot}; output cleanup is incomplete`
            : "Dossier publication failed and rollback is incomplete",
          {
            cause: failure,
            cleanup: failure.cleanup,
            cleanupOnly: tree.published,
          },
        );
        bindArtifactFileCleanup(failure, error);
        throw error;
      }
      if (tree.published && receipt) return receipt;
    }
    if (outcome.kind === "failed")
      throw outputDirectoryAdmissionRefusal(
        operation,
        "directory",
        outcome.cause,
      );
    throw new Error("Legacy project completed without publication");
  });
};

import { z } from "zod";
import { legacyJourneyViewRequestSchema } from "./analysisView/analysisViewRequest.js";
import type { AnalysisViewResult } from "./analysisView/analysisViewResult.js";
import {
  legacyCharacterizationInputSchema,
  legacyJourneyCleanupSchema,
  type LegacyJourneyManifest,
} from "./legacyJourney.js";
import { digestSchema, prefixedDigestSchema } from "./digests.js";
import { analyzeJavaScriptApplicationInputSchema } from "./javascript/javascriptApplicationAnalysis.js";
import { applicationFeatureSeedSchema } from "./javascript/javascriptFeatureTraceSchemas.js";
import { sourceToBundleComparisonResultSchema } from "./javascript/sourceToBundleComparisonSchemas.js";
import { localPathStringSchema } from "./localPath.js";
import { evidenceBundleSchema, type EvidenceBundle } from "./evidenceBundle.js";
import {
  reconstructionObligationLedgerInputSchema,
  obligationStatusSchema,
  type ReconstructionObligationLedger,
} from "./reconstructionObligationLedgerSchemas.js";

export interface LegacyJourneyProjectInput {
  readonly manifest: LegacyJourneyManifest;
  readonly journey: Extract<AnalysisViewResult, { kind: "legacy-journey" }>;
  readonly evidence: EvidenceBundle;
  readonly ledger: ReconstructionObligationLedger;
  readonly query?: z.output<typeof legacyJourneyViewRequestSchema>;
}

export interface LegacyJourneyProjectFile {
  readonly path: string;
  readonly content: string;
}

export const legacyPersistenceFamilySchema = z.enum([
  "legacy-clean-start",
  "legacy-same-build-restart",
  "legacy-in-place-upgrade",
]);
const stateSample = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("absent-file") }),
  z.strictObject({
    kind: z.literal("file"),
    relative_path: z.string().min(1),
    sha256: digestSchema,
    identity: z.string().min(1),
    selected_value: z
      .discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("value"), value: z.json() }),
        z.strictObject({ kind: z.literal("absent-member") }),
        z.strictObject({
          kind: z.literal("unknown"),
          reason: z.string().min(1),
        }),
      ])
      .optional(),
  }),
]);
export const legacyJourneyReceiptSchema = z.strictObject({
  version: z.literal(1),
  journey_id: z.string().min(1).max(256),
  build_sha256: digestSchema,
  candidate_sha256: digestSchema,
  seed: z.json(),
  cleanup: legacyJourneyCleanupSchema,
  residual_profile_root: z.string().min(1).nullable(),
  phases: z
    .array(
      z.strictObject({
        action: z.enum(["read-first", "seed"]),
        build_sha256: digestSchema,
        profile: z.string().min(1),
        profile_identity: z.string().min(1),
        process_identity: z.string().min(1),
        before: stateSample,
        after: stateSample,
        value: z.json(),
        handler_reply: z.json().optional(),
      }),
    )
    .max(7),
  cases: z
    .array(
      z.strictObject({
        family: legacyPersistenceFamilySchema,
        obligation_id: z.string().min(1),
        obligation_version: z.int().positive(),
        phases: z.array(z.int().nonnegative()).max(4),
        status: z.enum(["pass", "fail", "unknown"]),
        reason: z.string().min(1).optional(),
      }),
    )
    .length(3),
});
export type LegacyJourneyReceipt = z.output<typeof legacyJourneyReceiptSchema>;

// The workflow authenticates the bundle through the ledger's format owner.
const borrowedBundleSchema = z.unknown().nonoptional();
borrowedBundleSchema._zod.processJSONSchema =
  evidenceBundleSchema._zod.processJSONSchema;

export const legacyJourneyWorkflowInputSchema = z
  .strictObject({
    characterization: legacyCharacterizationInputSchema.optional(),
    build_evidence_id: prefixedDigestSchema("ev").optional(),
    local_inputs: z
      .strictObject({
        source: z.discriminatedUnion("kind", [
          z.strictObject({
            kind: z.literal("source-tree"),
            root: localPathStringSchema,
          }),
          z.strictObject({
            kind: z.literal("inventory-file"),
            path: localPathStringSchema,
          }),
        ]),
        build: analyzeJavaScriptApplicationInputSchema,
      })
      .optional(),
    evidence_bundle: borrowedBundleSchema.optional(),
    evidence_bundle_path: z.string().min(1).optional(),
    dossier_manifest_path: localPathStringSchema.optional(),
    view: legacyJourneyViewRequestSchema.optional(),
    feature_seeds: z.array(applicationFeatureSeedSchema).max(4).optional(),
    manifest:
      reconstructionObligationLedgerInputSchema.shape.manifest.optional(),
    export_directory: z.string().min(1).optional(),
    verification: z
      .union([
        z.strictObject({
          candidate_sha256: digestSchema,
          receipt: legacyJourneyReceiptSchema,
        }),
        z.strictObject({
          candidate_sha256: digestSchema,
          receipt_path: localPathStringSchema,
        }),
      ])
      .optional(),
  })
  .superRefine((input, context) => {
    const bundleCount =
      Number(input.evidence_bundle !== undefined) +
      Number(input.evidence_bundle_path !== undefined);
    if (input.dossier_manifest_path !== undefined) {
      if (
        bundleCount !== 0 ||
        input.local_inputs !== undefined ||
        input.characterization !== undefined ||
        input.build_evidence_id !== undefined ||
        input.view !== undefined ||
        input.feature_seeds !== undefined ||
        input.verification === undefined
      )
        context.addIssue({
          code: "custom",
          path: ["dossier_manifest_path"],
          message:
            "Select the exported manifest and a verifier receipt. The dossier supplies the build, view, and bundle.",
        });
      return;
    }
    if (input.view === undefined)
      context.addIssue({
        code: "custom",
        path: ["view"],
        message: "Select a journey view",
      });
    if (
      bundleCount > 1 ||
      (input.local_inputs === undefined && bundleCount !== 1)
    )
      context.addIssue({
        code: "custom",
        path: ["evidence_bundle"],
        message:
          "Select one bundle source. The bundle is optional for local inputs.",
      });
    if (
      input.local_inputs === undefined
        ? input.characterization === undefined ||
          input.build_evidence_id === undefined
        : input.characterization !== undefined ||
          input.build_evidence_id !== undefined
    )
      context.addIssue({
        code: "custom",
        path: ["local_inputs"],
        message:
          "Supply local inputs or the pair of prepared characterization and retained build Evidence ID.",
      });
  });

export const legacyJourneyWorkflowResultSchema = z.strictObject({
  dossier_sha256: digestSchema,
  journey_id: z.string(),
  view_evidence_id: prefixedDigestSchema("ev"),
  ledger_evidence_id: prefixedDigestSchema("ev"),
  source_comparison_evidence_id: prefixedDigestSchema("ev").nullable(),
  coverage: sourceToBundleComparisonResultSchema.shape.coverage.shape.status,
  obligations: z.array(
    z.strictObject({
      obligation_id: z.string(),
      family: z.string(),
      status: obligationStatusSchema,
      verifier_status: z
        .enum(["pass", "fail", "unknown", "unsupported", "skipped"])
        .nullable(),
    }),
  ),
  diagnostics: z.array(z.string()),
  verification_evidence_id: prefixedDigestSchema("ev").nullable(),
  export: z
    .strictObject({
      directory: z.string(),
      files: z.array(
        z.strictObject({
          path: z.string(),
          sha256: digestSchema,
          bytes: z.int().nonnegative(),
        }),
      ),
    })
    .nullable(),
});

import { z } from "zod";
import { digestSchema } from "./digests.js";
import { historicalSourceGraphSchema } from "./referenceSourceGraph.js";
import { sourceToBundleComparisonResultSchema } from "./javascript/sourceToBundleComparisonSchemas.js";

// lifecycle-state: whether the standalone runner released its disposable profile.
export const legacyJourneyCleanupSchema = z.enum(["complete", "incomplete"]);

export const legacyCharacterizationInputSchema = z
  .strictObject({
    source: z.strictObject({
      inventory: historicalSourceGraphSchema,
      revision: z.string().min(1).nullable(),
    }),
    build: z.strictObject({ artifact_sha256: digestSchema }),
    choices: z.json(),
    comparison: z.discriminatedUnion("state", [
      z.strictObject({
        state: z.literal("available"),
        result: sourceToBundleComparisonResultSchema,
      }),
      z.strictObject({
        state: z.literal("unavailable"),
        reason: z.string().min(1),
      }),
    ]),
  })
  .superRefine((input, context) => {
    if (input.comparison.state !== "available") return;
    if (
      input.comparison.result.reference.root_sha256 !==
      input.source.inventory.root_sha256
    )
      context.addIssue({
        code: "custom",
        path: ["comparison", "result", "reference"],
        message: "Comparison source identity does not match inventory",
      });
    if (
      input.comparison.result.application.root_artifact_sha256 !==
      input.build.artifact_sha256
    )
      context.addIssue({
        code: "custom",
        path: ["comparison", "result", "application"],
        message: "Comparison artifact identity does not match build",
      });
  });

export type LegacyCharacterizationInput = z.output<
  typeof legacyCharacterizationInputSchema
>;
type Mapping = LegacyCharacterizationInput["comparison"] & {
  state: "available";
};
type Item = Mapping["result"]["items"][number];
export interface LegacyJourneyManifest {
  readonly version: 1;
  readonly source: LegacyCharacterizationInput["source"];
  readonly build: LegacyCharacterizationInput["build"];
  readonly choices: LegacyCharacterizationInput["choices"];
  readonly comparison: LegacyCharacterizationInput["comparison"];
  readonly coverage: "complete-within-inputs" | "partial" | "unknown";
  readonly correspondence: {
    readonly matched: readonly Item[];
    readonly partial: readonly Item[];
    readonly unknown: readonly (Item | { readonly reason: string })[];
  };
}

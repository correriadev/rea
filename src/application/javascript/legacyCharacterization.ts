import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import {
  legacyCharacterizationInputSchema,
  type LegacyJourneyManifest,
} from "../../domain/legacyJourney.js";
import { err, ok, type Result } from "../../domain/result.js";

/** Preserve the source and build identities alongside the comparison that binds them. */
export const characterizeLegacyJourney = (
  input: unknown,
): Result<LegacyJourneyManifest, AnalysisError> => {
  const parsed = legacyCharacterizationInputSchema.safeParse(input);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(
        "characterize_legacy_journey",
        parsed.error.issues,
        input,
      ),
    );
  const { source, build, choices, comparison } = parsed.data;
  const items = comparison.state === "available" ? comparison.result.items : [];
  return ok({
    version: 1,
    source,
    build,
    choices,
    comparison,
    coverage:
      comparison.state === "unavailable"
        ? "partial"
        : comparison.result.coverage.status,
    correspondence: {
      matched: items.filter((item) =>
        ["unchanged", "modified", "split", "merged", "duplicated"].includes(
          item.status,
        ),
      ),
      partial: items.filter((item) => item.status === "removed"),
      unknown:
        comparison.state === "unavailable"
          ? [{ reason: comparison.reason }]
          : items.filter((item) => item.status === "unknown"),
    },
  });
};

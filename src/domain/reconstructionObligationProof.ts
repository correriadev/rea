import { z } from "zod";

import { digestSchema, prefixedDigestSchema } from "./digests.js";
import { STABLE_IDENTIFIER_PATTERN } from "./stringPatterns.js";
import { obligationCaseKindSchema } from "./reconstructionObligationLedgerSchemas.js";

const stableIdSchema = z.string().regex(STABLE_IDENTIFIER_PATTERN);
const reconstructionRunReceiptSchema = z.strictObject({
  baseline_owner_sha256: digestSchema,
  candidate_owner_sha256: digestSchema,
  conditions_sha256: digestSchema,
  // lifecycle-state: Whether the verification run finished cleaning up its resources.
  cleanup: z.enum(["complete", "incomplete"]),
  witnesses: z.array(
    z.strictObject({
      checkpoint_id: stableIdSchema,
      evidence_id: prefixedDigestSchema("ev"),
    }),
  ),
});

/** Caller-produced proof binds each claim to one implementation and revision. */
export const reconstructionObligationProofSchema = z.strictObject({
  bindings: z
    .array(
      z.strictObject({
        obligation_id: stableIdSchema,
        obligation_version: z.int().min(1),
        owner_sha256: digestSchema,
        fixtures: z.array(
          z.strictObject({
            fixture_id: stableIdSchema,
            case_kind: obligationCaseKindSchema,
            passed: z.boolean(),
          }),
        ),
        verifiers: z.array(
          z.strictObject({
            verifier_id: stableIdSchema,
            claim_id: stableIdSchema,
            passed: z.boolean(),
          }),
        ),
        run: reconstructionRunReceiptSchema.optional(),
      }),
    )
    .min(1),
});

export type ReconstructionObligationProof = z.infer<
  typeof reconstructionObligationProofSchema
>;

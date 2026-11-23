import { sha256Hex } from "../kernel/sha256Hex.js";
import { z } from "zod";
import type { EvidenceLookup } from "./EvidenceInputResolver.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import {
  equalJsonValues,
  jsonValueSchema,
  type JsonValue,
} from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import { decodeStrictUtf8 } from "../domain/strictUtf8.js";
import { isRecord } from "../kernel/isRecord.js";

const operation = "admit_legacy_journey_observations";
const text = z.string().min(1);
const digest = z.string().regex(/^[a-fA-F0-9]{64}$/);
const scopeSchema = z.strictObject({
  capture: text,
  build_sha256: digest,
  profile_directory: text,
  process_identity: text,
});
const valueSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("value"), value: jsonValueSchema }),
  z.strictObject({ kind: z.literal("absent-file") }),
  z.strictObject({ kind: z.literal("absent-member") }),
]);
const memberPath = z.array(z.string().max(256)).min(1).max(16);
const sourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("evidence"),
    evidence_id: text,
    member_path: memberPath.optional(),
  }),
  z.strictObject({
    kind: z.literal("external-state"),
    path: text,
    file_identity: text,
    bytes_base64: z.string(),
    bytes_sha256: digest,
    member_path: memberPath.optional(),
  }),
]);
const common = {
  id: text,
  field: text,
  role: z.enum(["entry", "precondition", "action", "effect"]),
  phase: text,
  scope: scopeSchema,
};
const observationSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...common, status: z.literal("unknown"), reason: text }),
  z.strictObject({
    ...common,
    status: z.literal("observed"),
    value: valueSchema,
    source: sourceSchema,
  }),
  z.strictObject({
    ...common,
    status: z.literal("derived"),
    value: valueSchema,
    parents: z.array(text).min(1),
  }),
]);
export type LegacyJourneyObservation = z.output<typeof observationSchema>;

/** Check a selected value or explicit absence at an already admitted location. */
function matchesMember(
  root: unknown,
  path: readonly string[],
  expected: z.output<typeof valueSchema>,
) {
  let current: unknown = root;
  for (const [index, key] of path.entries()) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(key)) return false;
      const position = Number(key);
      if (position >= current.length)
        return index === path.length - 1 && expected.kind === "absent-member";
      current = current[position];
    } else {
      if (!isRecord(current)) return false;
      if (!Object.hasOwn(current, key))
        return index === path.length - 1 && expected.kind === "absent-member";
      current = current[key];
    }
  }
  const member = jsonValueSchema.safeParse(current);
  if (!member.success) return false;
  return equalJsonValues(
    member.data,
    expected.kind === "value" ? expected.value : expected,
  );
}

/** Admit scoped witnesses without filling unobserved fields or merging captures. */
export const admitLegacyJourneyObservations = (
  input: unknown,
  lookup: EvidenceLookup,
  onUnavailableEvidence?: (observationId: string, evidenceId: string) => void,
): Result<readonly LegacyJourneyObservation[], AnalysisInputError> => {
  const parsed = z.array(observationSchema).safeParse(input);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(operation, parsed.error.issues, input, {
        cause: parsed.error,
      }),
    );
  const records = new Map<string, LegacyJourneyObservation>();
  for (const item of parsed.data) {
    const previous = records.get(item.id);
    if (
      previous !== undefined &&
      !equalJsonValues(previous as JsonValue, item as JsonValue)
    )
      return invalid(`Conflicting observation ID: ${item.id}`);
    records.set(item.id, previous ?? item);
  }
  const unavailable = new Map<string, string>();
  for (const item of records.values()) {
    if (item.status === "observed") {
      const source = item.source;
      if (source.kind === "evidence") {
        const evidence = lookup(source.evidence_id);
        if (
          evidence === undefined ||
          evidence.evidence_id !== source.evidence_id
        ) {
          if (onUnavailableEvidence === undefined)
            return invalid(`Missing retained Evidence: ${source.evidence_id}`);
          onUnavailableEvidence(item.id, source.evidence_id);
          unavailable.set(item.id, "Retained witness is unavailable");
        } else if (
          source.member_path !== undefined &&
          !matchesMember(
            evidence.normalized_result,
            source.member_path,
            item.value,
          )
        ) {
          return invalid(
            `Retained Evidence member does not corroborate observation ${item.id}`,
          );
        }
      } else {
        if (item.value.kind === "absent-file")
          return invalid(
            `External bytes cannot witness an absent file: ${item.id}`,
          );
        const bytes = Buffer.from(source.bytes_base64, "base64");
        if (
          bytes.toString("base64") !== source.bytes_base64 ||
          sha256Hex(bytes) !== source.bytes_sha256.toLowerCase()
        )
          return invalid(`Invalid external state bytes for ${item.id}`);
        if (source.member_path !== undefined) {
          let decoded: unknown;
          try {
            decoded = JSON.parse(decodeStrictUtf8(bytes, "strip-signature"));
          } catch {
            return invalid(
              `External witness for ${item.id} is not valid UTF-8 JSON`,
            );
          }
          if (!matchesMember(decoded, source.member_path, item.value))
            return invalid(
              `External state member does not corroborate observation ${item.id}`,
            );
        }
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const check = (item: LegacyJourneyObservation): boolean => {
    if (visited.has(item.id)) return true;
    if (visiting.has(item.id)) return false;
    visiting.add(item.id);
    if (item.status === "derived") {
      for (const id of item.parents) {
        const parent = records.get(id);
        if (
          parent === undefined ||
          parent.status === "unknown" ||
          parent.field !== item.field ||
          parent.role !== item.role ||
          parent.phase !== item.phase ||
          !equalJsonValues(
            parent.value as JsonValue,
            item.value as JsonValue,
          ) ||
          !equalJsonValues(
            parent.scope as JsonValue,
            item.scope as JsonValue,
          ) ||
          !check(parent)
        )
          return false;
        if (unavailable.has(id))
          unavailable.set(item.id, `Observation parent ${id} is unavailable`);
      }
    }
    visiting.delete(item.id);
    visited.add(item.id);
    return true;
  };
  for (const item of records.values()) {
    if (!check(item))
      return invalid(
        `Parents for ${item.id} must be acyclic and agree on the field, phase, value and capture scope`,
      );
  }
  return ok(
    [...records.values()].map((item) => {
      const reason = unavailable.get(item.id);
      if (reason === undefined) return item;
      const { id, field, role, phase, scope } = item;
      return {
        id,
        field,
        role,
        phase,
        scope,
        status: "unknown" as const,
        reason,
      };
    }),
  );
};

const invalid = (message: string): Result<never, AnalysisInputError> =>
  err(new AnalysisInputError(operation, { userMessage: message }));

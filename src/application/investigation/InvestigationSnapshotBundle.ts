import {
  createEvidenceBundle,
  referencedEvidenceIds,
  type EvidenceBundle,
} from "../../domain/evidenceBundle.js";
import { EvidenceReferenceError } from "../../domain/evidenceErrors.js";
import { readEvidencePayload } from "../../domain/evidenceValidation.js";
import { investigationGraphSchema } from "../../domain/investigationGraph.js";
import { err, ok } from "../../domain/result.js";
import type { Evidence } from "../../domain/evidence.js";
import type { ResidualUnknown } from "../../domain/residualUnknown.js";
import { collectInvestigationEvidenceClosure } from "./InvestigationEvidence.js";
import type { EvidenceReader } from "./InvestigationRecordPort.js";
import type { InvestigationWorkflowExecution } from "./InvestigationWorkflows.js";

export type InvestigationSnapshotReader = Pick<
  EvidenceReader,
  "evidenceForAnalysis" | "immutableEvidenceBundle"
>;

export const investigationSnapshotReader = (
  bundle: EvidenceBundle,
): InvestigationSnapshotReader => {
  const records = new Map(
    bundle.records.map((record) => [record.evidence_id, record]),
  );
  return {
    evidenceForAnalysis: (id) => records.get(id),
    immutableEvidenceBundle: () => bundle,
  };
};

export const emptyInvestigationSnapshotReader = investigationSnapshotReader(
  createEvidenceBundle([]),
);

/** Select a snapshot, its linked records, and the complete histories of pinned Unknowns. */
export const investigationSnapshotBundle = (
  execution: InvestigationWorkflowExecution,
  reader: InvestigationSnapshotReader,
) => {
  const supplied = new Map(
    [execution.evidence, ...execution.sources].map((record) => [
      record.evidence_id,
      record,
    ]),
  );
  const lookup = {
    evidenceForAnalysis: (id: string) =>
      supplied.get(id) ?? reader.evidenceForAnalysis(id),
  };
  const histories = new Map<string, ResidualUnknown[]>();
  const unknowns: ResidualUnknown[] = [];
  const records = new Map<string, Evidence>();
  const selectedUnknowns = new Set<string>();
  let pending = [execution.evidence.evidence_id];
  while (pending.length > 0) {
    const closure = collectInvestigationEvidenceClosure(lookup, pending);
    if (!closure.result.ok) return closure.result;
    const unknownIds: string[] = [];
    for (const record of closure.records) {
      if (records.has(record.evidence_id)) continue;
      records.set(record.evidence_id, record);
      if (
        record.predicate_type !== "rea.investigation-graph" ||
        record.operation !== "update_investigation_graph"
      )
        continue;
      const graph = readEvidencePayload(
        investigationGraphSchema,
        record.normalized_result,
        { within: ["normalized_result"] },
      );
      if (!graph.ok) return graph;
      for (const gap of graph.value.gaps)
        if (gap.unknown !== null) unknownIds.push(gap.unknown.unknown_id);
    }
    pending = [];
    if (unknownIds.length === 0) break;
    if (histories.size === 0) {
      for (const record of reader.immutableEvidenceBundle().unknowns) {
        const found = histories.get(record.unknown_id);
        if (found === undefined) histories.set(record.unknown_id, [record]);
        else found.push(record);
      }
    }
    for (const id of unknownIds) {
      if (selectedUnknowns.has(id)) continue;
      const history = histories.get(id);
      if (history === undefined)
        return err(
          new EvidenceReferenceError(id, "missing", {
            expected: "Pinned Unknown history",
            actual: null,
          }),
        );
      selectedUnknowns.add(id);
      for (const revision of history) {
        unknowns.push(revision);
        for (const linkedId of referencedEvidenceIds(revision))
          if (!records.has(linkedId)) pending.push(linkedId);
        for (const related of revision.relationships)
          unknownIds.push(related.unknown_id);
      }
    }
  }
  return ok(createEvidenceBundle([...records.values()], unknowns));
};

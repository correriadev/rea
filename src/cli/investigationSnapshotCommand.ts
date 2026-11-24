import type { Logger } from "pino";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { ok, type Result } from "../domain/result.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import { ArtifactResourceScope } from "../resources/index.js";
import type { InvestigationWorkflowExecution } from "../application/investigation/InvestigationWorkflows.js";
import type { InvestigationSnapshotReader } from "../application/investigation/InvestigationSnapshotBundle.js";
import { registerContractDocumentCommand } from "./contractCommand.js";
import { evidenceBundleOption } from "./evidenceInputCommand.js";
import { finishAnalysisCommand } from "./finishAnalysisCommand.js";
import { parseAnalysisInput } from "../application/AnalysisInput.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { CliInstance } from "./types.js";

/** Compose a snapshot and atomically publish its selected Evidence closure. */
export const registerInvestigationSnapshotCommand = (
  cli: CliInstance,
  logger: Logger,
  contract: ToolContract,
  update: (
    input: unknown,
    reader: InvestigationSnapshotReader,
    signal: AbortSignal,
  ) => Promise<Result<InvestigationWorkflowExecution, AnalysisError>>,
): void => {
  registerContractDocumentCommand(
    cli,
    logger,
    contract,
    {
      description: contract.description,
      document: "Inline workflow JSON or JSON file path",
      cliOptions: {
        evidenceBundle: evidenceBundleOption,
        evidenceOutput: localPathStringSchema.describe(
          "Write the snapshot and its source closure to a new Evidence bundle.",
        ),
      },
    },
    async (document, { frame, signal, operation, cliOptions }) => {
      const framed = parseAnalysisInput(operation, document, frame, signal);
      if (!framed.ok) return projectAnalysisError(framed.error);
      const resources = new ArtifactResourceScope();
      const result = await finishAnalysisCommand(
        async () => {
          const { readImmutableEvidenceBundle } =
            await import("../application/EvidenceBundleFiles.js");
          const {
            emptyInvestigationSnapshotReader,
            investigationSnapshotBundle,
            investigationSnapshotReader,
          } =
            await import("../application/investigation/InvestigationSnapshotBundle.js");
          const { publishEvidenceDelivery } =
            await import("../application/EvidenceBundleCommands.js");
          let reader = emptyInvestigationSnapshotReader;
          if (cliOptions.evidenceBundle !== undefined) {
            const selected = await readImmutableEvidenceBundle(
              absoluteCallerPath(cliOptions.evidenceBundle),
              signal,
              resources,
              operation,
            );
            if (!selected.ok) return selected;
            reader = investigationSnapshotReader(selected.value);
          }
          const execution = await update(document, reader, signal);
          if (!execution.ok) return execution;
          const complete = execution.value.evidence;
          const bundle = investigationSnapshotBundle(execution.value, reader);
          if (!bundle.ok) return bundle;
          const published = await publishEvidenceDelivery({
            bundle: bundle.value,
            complete,
            delivered: complete,
            outputPath: absoluteCallerPath(cliOptions.evidenceOutput),
            operation,
            signal,
          });
          return published.ok ? ok(published.value.delivered) : published;
        },
        resources,
        "rea-workflow",
        operation,
        signal,
      );
      return result.ok ? result.value : result.error;
    },
  );
};

import { dirname, join } from "node:path";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisCapabilityUnavailableError,
} from "../domain/analysisErrorCore.js";
import { digestCanonicalValue } from "../domain/canonicalDigest.js";
import { analysisViewResultSchema } from "../domain/analysisView/analysisViewResult.js";
import {
  createEvidence,
  evidenceFileTarget,
  type Evidence,
} from "../domain/evidence.js";
import { createEvidenceBundle } from "../domain/evidenceBundle.js";
import { retainedEvidenceReferenceSchema } from "../domain/evidenceReference.js";
import { prefixedDigestSchema } from "../domain/digests.js";
import { legacyCharacterizationInputSchema } from "../domain/legacyJourney.js";
import { legacyJourneyViewRequestSchema } from "../domain/analysisView/analysisViewRequest.js";
import { equalJsonValues } from "../domain/jsonValue.js";
import { JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER } from "../domain/investigationProviders.js";
import {
  legacyJourneyWorkflowInputSchema,
  legacyJourneyWorkflowResultSchema,
} from "../domain/legacyJourneyProject.js";
import { reconstructionObligationLedgerSchema } from "../domain/reconstructionObligationLedgerSchemas.js";
import { err, ok, type Result } from "../domain/result.js";
import { unknownTarget } from "../domain/targetIdentity.js";
import { createHistoricalSourceGraph } from "../domain/referenceSourceGraph.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { ArtifactResourceScope } from "../resources/index.js";
import { inspectAnalysisViewValidated } from "./analysisView/AnalysisViewService.js";
import { parseAnalysisInput } from "./AnalysisInput.js";
import { readImmutableEvidenceBundle } from "./EvidenceBundleFiles.js";
import { readJsonFile, readJsonFileWithSource } from "./JsonFiles.js";
import { characterizeLegacyJourney } from "./javascript/legacyCharacterization.js";
import { writeLegacyJourneyProject } from "./legacyJourneyExport.js";
import {
  admitLegacyJourneyReceipt,
  legacyJourneyReceiptProof,
} from "./legacyJourneyVerification.js";
import { resolveReconstructionObligationLedgerRequest } from "./ReconstructionObligationLedgerRequest.js";
import { buildResolvedReconstructionObligationLedgerEvidence } from "./ReconstructionObligationLedgerService.js";
import type { EvidenceWorkflowExecution } from "./investigation/EvidenceWorkflowExecution.js";
import type { JavaScriptApplicationOptions } from "./javascript/JavaScriptApplicationService.js";
import { importReferenceSource } from "./ReferenceSourceImport.js";
import { referenceSourceImportAnalysisError } from "./ReferenceSourceImportTypes.js";
import { parseConfig } from "../config/parseConfig.js";
import { resolveJavaScriptMemberMutationAllowance } from "../config/javascriptMemberMutationAllowance.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { resolveSourceToBundleReference } from "./javascript/SourceToBundleReference.js";
import {
  executeSourceToBundleComparison,
  traceApplicationFeatureEvidence,
} from "./javascript/JavaScriptApplicationWorkflowService.js";
import { z } from "zod";

export const LEGACY_JOURNEY_OPERATION =
  "characterize_legacy_application_journey";

type WorkflowInput = z.output<typeof legacyJourneyWorkflowInputSchema>;

const savedDossierSchema = z.object({
  version: z.literal(1),
  characterization: z.object(legacyCharacterizationInputSchema.shape),
  bundle: z.literal("evidence.json"),
  restore_query: z.literal("journey-query.json"),
  view_evidence_id: prefixedDigestSchema("ev").optional(),
});
const savedQuerySchema = z.strictObject({
  source: retainedEvidenceReferenceSchema,
  view: legacyJourneyViewRequestSchema,
});
const viewCommitmentSchema = z.object({
  parent_evidence_id: prefixedDigestSchema("ev"),
  view: z.object({
    kind: z.literal("legacy-journey"),
    input_digest: z.string(),
  }),
});
const invalidDossier = (userMessage: string) =>
  err(new AnalysisInputError(LEGACY_JOURNEY_OPERATION, { userMessage }));

async function loadJourneyDossier(
  path: string,
  resources: ArtifactResourceScope,
  signal?: AbortSignal,
) {
  const file = await readJsonFileWithSource(
    path,
    signal,
    resources,
    LEGACY_JOURNEY_OPERATION,
  );
  if (!file.ok) return file;
  const manifest = savedDossierSchema.safeParse(file.value.data);
  if (!manifest.success)
    return invalidDossier(
      "Select a REA dossier manifest with a portable restore query.",
    );
  const directory = dirname(file.value.path);
  const query = await readJsonFile(
    join(directory, manifest.data.restore_query),
    signal,
    resources,
    LEGACY_JOURNEY_OPERATION,
  );
  if (!query.ok) return query;
  const saved = savedQuerySchema.safeParse(query.value);
  if (!saved.success)
    return invalidDossier("The saved dossier query is malformed.");
  return ok({
    characterization: manifest.data.characterization,
    preferred_view_id: manifest.data.view_evidence_id,
    bundlePath: join(directory, manifest.data.bundle),
    query: saved.data,
  });
}

async function acquireLocalInputs(
  inputs: NonNullable<WorkflowInput["local_inputs"]>,
  resources: ArtifactResourceScope,
  options: JavaScriptApplicationOptions,
) {
  const { source, build } = inputs;
  const loaded = await (async () => {
    if (source.kind === "inventory-file") {
      const resolved = await resolveSourceToBundleReference(
        { kind: "file", path: source.path },
        options.signal,
        resources,
      );
      return resolved.ok
        ? ok({ inventory: resolved.value.reference, unavailable: null })
        : resolved;
    }
    const config = parseConfig(options.environment ?? {});
    if (!config.ok) return config;
    const allowance = resolveJavaScriptMemberMutationAllowance(
      options.environment,
      options.settings?.().overrides,
    );
    if (!allowance.ok) return allowance;
    const imported = await importReferenceSource(
      {
        root: source.root,
        policy: config.value.referenceSourcePolicy,
        caller: LEGACY_JOURNEY_OPERATION,
        importer: PRODUCT_IDENTITY.packageName,
        importerVersion: PRODUCT_IDENTITY.packageVersion,
        memberMutationAllowance: allowance.value,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      resources,
    );
    if (imported.ok)
      return ok({ inventory: imported.value, unavailable: null });
    if (imported.error.code !== "unsupported" || imported.error.cleanup)
      return err(referenceSourceImportAnalysisError(imported.error));
    const unavailable = `${imported.error.message}. Supply a historical inventory file produced on a supported host.`;
    return ok({
      unavailable,
      inventory: createHistoricalSourceGraph({
        schema: "HistoricalSourceGraph",
        authority: "historical-reference",
        root_alias: "$REFERENCE_ROOT",
        inventory_state: "partial",
        entries: [],
        relationships: [],
        parse_failures: [],
        exclusions: [],
        languages: [],
        manifests: [],
        vcs: null,
        provenance: {
          importer: PRODUCT_IDENTITY.packageName,
          importer_version: PRODUCT_IDENTITY.packageVersion,
          caller: LEGACY_JOURNEY_OPERATION,
        },
        limitations: [unavailable],
      }),
    });
  })();
  if (!loaded.ok) return loaded;
  const { inventory, unavailable } = loaded.value;
  const { analyzeJavaScriptApplicationValidated } =
    await import("./javascript/JavaScriptApplicationService.js");
  const analyzed = await analyzeJavaScriptApplicationValidated(
    build,
    resources,
    options,
  );
  if (!analyzed.ok) return analyzed;
  const parent = analyzed.value;
  const digest = evidenceFileTarget(parent)?.sha256;
  if (!digest)
    return err(
      new AnalysisOutputError(
        LEGACY_JOURNEY_OPERATION,
        "The build analysis has no file identity",
      ),
    );
  const characterization = {
    source: { inventory, revision: inventory.vcs?.head ?? null },
    build: { artifact_sha256: digest },
    // Record only the caller's analyzed paths and options, never the environment.
    choices: { source, build },
  };
  if (unavailable !== null)
    return ok({
      parent,
      comparison: null,
      characterization: {
        ...characterization,
        comparison: { state: "unavailable" as const, reason: unavailable },
      },
    });
  const compared = await executeSourceToBundleComparison(
    {
      reference: inventory,
      application: {
        kind: "retained-evidence",
        evidence_id: parent.evidence_id,
      },
    },
    (id) => (id === parent.evidence_id ? parent : undefined),
    resources,
    options,
  );
  if (!compared.ok) return compared;
  return ok({
    parent,
    comparison: compared.value.evidence,
    characterization: {
      ...characterization,
      comparison: {
        state: "available" as const,
        result: compared.value.result,
      },
    },
  });
}

/** Coordinate existing owners through one application entry point. */
export const characterizeLegacyApplicationJourney = async (
  input: unknown,
  {
    resources = new ArtifactResourceScope(),
    signal,
    analysis,
  }: {
    readonly resources?: ArtifactResourceScope | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly analysis?:
      | Omit<JavaScriptApplicationOptions, "signal">
      | undefined;
  } = {},
): Promise<Result<EvidenceWorkflowExecution, AnalysisError>> => {
  const parsed = parseAnalysisInput(
    LEGACY_JOURNEY_OPERATION,
    input,
    legacyJourneyWorkflowInputSchema,
    signal,
  );
  if (!parsed.ok) return parsed;
  const request = parsed.value;
  const loaded =
    request.dossier_manifest_path === undefined
      ? undefined
      : await loadJourneyDossier(
          request.dossier_manifest_path,
          resources,
          signal,
        );
  if (loaded !== undefined && !loaded.ok) return loaded;
  const dossier = loaded?.value;
  if (
    dossier === undefined &&
    request.view?.verification_evidence_id !== undefined
  )
    return err(
      new AnalysisInputError(LEGACY_JOURNEY_OPERATION, {
        userMessage:
          "Submit a verification receipt through verification, or use inspect_analysis_view to restore a previously verified view.",
      }),
    );
  const selectedView = dossier?.query.view ?? request.view;
  if (!selectedView) return invalidDossier("Select a journey view.");
  const { verification_evidence_id: _previousReceipt, ...baseView } =
    selectedView;
  let acquired:
    | {
        parent: Evidence;
        comparison: Evidence | null;
        characterization: unknown;
      }
    | undefined;
  if (request.local_inputs !== undefined) {
    if (!analysis)
      return err(
        new AnalysisCapabilityUnavailableError(
          "rea-javascript-application",
          LEGACY_JOURNEY_OPERATION,
          "The JavaScript analyzer has not been composed",
        ),
      );
    const result = await acquireLocalInputs(request.local_inputs, resources, {
      ...analysis,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!result.ok) return result;
    acquired = result.value;
  }
  const characterized = characterizeLegacyJourney(
    acquired?.characterization ??
      dossier?.characterization ??
      request.characterization,
  );
  if (!characterized.ok) return characterized;
  let bundleInput = request.evidence_bundle;
  const bundlePath = dossier?.bundlePath ?? request.evidence_bundle_path;
  if (bundlePath !== undefined) {
    const loaded = await readImmutableEvidenceBundle(
      bundlePath,
      signal,
      resources,
      LEGACY_JOURNEY_OPERATION,
    );
    if (!loaded.ok) return loaded;
    bundleInput = loaded.value;
  }
  const resolved = resolveReconstructionObligationLedgerRequest({
    evidence_bundle:
      bundleInput === undefined ? createEvidenceBundle([]) : bundleInput,
    reviewed_obligations: [],
    manifest: request.manifest ?? { bindings: [], contradictions: [] },
  });
  if (!resolved.ok) return resolved;
  const records = new Map(resolved.value.sources.records);
  if (dossier !== undefined) {
    const digest = digestCanonicalValue(
      dossier.query.view,
      "Legacy journey request",
    );
    const parentId = dossier.query.source.evidence_id;
    const committed = [...records.values()].some((item) => {
      if (
        item.operation !== "inspect_analysis_view" ||
        (dossier.preferred_view_id !== undefined &&
          dossier.preferred_view_id !== item.evidence_id) ||
        !item.evidence_links.includes(parentId)
      )
        return false;
      const commitment = viewCommitmentSchema.safeParse(item.parameters);
      return (
        commitment.success &&
        commitment.data.parent_evidence_id === parentId &&
        commitment.data.view.input_digest === digest
      );
    });
    if (!committed)
      return invalidDossier(
        "The portable query does not match a committed view in the selected bundle.",
      );
  }
  if (acquired) {
    records.set(acquired.parent.evidence_id, acquired.parent);
    if (acquired.comparison)
      records.set(acquired.comparison.evidence_id, acquired.comparison);
  }
  const parent =
    acquired?.parent ??
    records.get(
      dossier?.query.source.evidence_id ?? request.build_evidence_id ?? "",
    );
  if (
    parent === undefined ||
    evidenceFileTarget(parent)?.sha256 !==
      characterized.value.build.artifact_sha256
  )
    return err(
      new AnalysisInputError(LEGACY_JOURNEY_OPERATION, {
        userMessage:
          "The selected build Evidence must exist in the bundle and match the manifest digest.",
      }),
    );
  const comparison = characterized.value.comparison;
  const comparisonId =
    acquired?.comparison?.evidence_id ??
    (comparison.state === "available"
      ? [...records.values()].find(
          (item) =>
            item.operation === "compare_source_to_bundle" &&
            item.evidence_links.includes(parent.evidence_id) &&
            equalJsonValues(item.normalized_result, comparison.result),
        )?.evidence_id
      : undefined);
  if (
    dossier !== undefined &&
    comparison.state === "available" &&
    comparisonId === undefined
  )
    return invalidDossier(
      "The dossier's source comparison has no matching retained Evidence.",
    );
  const traces = new Set(baseView.trace_evidence_ids);
  for (const seed of request.feature_seeds ?? []) {
    const trace = traceApplicationFeatureEvidence(
      {
        application: {
          kind: "retained-evidence",
          evidence_id: parent.evidence_id,
        },
        seed,
        direction: "both",
      },
      (id) => records.get(id),
      signal === undefined ? {} : { signal },
    );
    if (!trace.ok) return trace;
    records.set(trace.value.evidence.evidence_id, trace.value.evidence);
    traces.add(trace.value.evidence.evidence_id);
  }
  if (traces.size > 4)
    return err(
      new AnalysisInputError(LEGACY_JOURNEY_OPERATION, {
        userMessage:
          "Select at most four distinct generated or retained feature traces.",
      }),
    );
  const viewRequest =
    traces.size === 0
      ? baseView
      : { ...baseView, trace_evidence_ids: [...traces] };
  const projected = inspectAnalysisViewValidated(
    {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view: viewRequest,
    },
    (id) => records.get(id),
  );
  if (!projected.ok) return projected;
  records.set(projected.value.evidence_id, projected.value);
  let evidence = createEvidenceBundle(
    [...records.values()],
    resolved.value.sources.bundle.unknowns,
  );
  let ledgerEvidence = buildResolvedReconstructionObligationLedgerEvidence({
    ...resolved.value,
    sources: { bundle: evidence, records },
  });
  let ledger = reconstructionObligationLedgerSchema.parse(
    ledgerEvidence.normalized_result,
  );
  const journey = analysisViewResultSchema.parse(
    projected.value.normalized_result,
  );
  if (journey.kind !== "legacy-journey")
    return err(
      new AnalysisOutputError(
        LEGACY_JOURNEY_OPERATION,
        "Unexpected journey projection",
      ),
    );
  const selectedObligations = () =>
    ledger.obligations.filter(({ authority_references }) =>
      authority_references.some(
        ({ evidence_id }) => evidence_id === projected.value.evidence_id,
      ),
    );
  let verificationId: string | null = null;
  let publishedView = projected.value;
  let publishedJourney = journey;
  let restoreQuery: NonNullable<WorkflowInput["view"]> = viewRequest;
  const verification = request.verification;
  if (verification !== undefined) {
    const receipt =
      "receipt" in verification
        ? ok(verification.receipt)
        : await readJsonFile(
            verification.receipt_path,
            signal,
            resources,
            LEGACY_JOURNEY_OPERATION,
          );
    if (!receipt.ok) return receipt;
    const admitted = admitLegacyJourneyReceipt(receipt.value, {
      journeyId: journey.journey_id,
      baseline: journey.build_sha256,
      candidate: verification.candidate_sha256,
      obligations: selectedObligations(),
    });
    if (!admitted.ok) return admitted;
    const proof = legacyJourneyReceiptProof(
      admitted.value,
      projected.value.evidence_id,
    );
    verificationId = proof.evidence.evidence_id;
    const newBindingIds = new Set(
      proof.bindings.map(({ obligation_id }) => obligation_id),
    );
    if (
      resolved.value.manifest.bindings.some(({ obligation_id }) =>
        newBindingIds.has(obligation_id),
      )
    )
      return err(
        new AnalysisInputError(LEGACY_JOURNEY_OPERATION, {
          userMessage:
            "A submitted run conflicts with an explicit owner binding for the same obligation.",
        }),
      );
    records.set(verificationId, proof.evidence);
    evidence = createEvidenceBundle([...records.values()], evidence.unknowns);
    ledgerEvidence = buildResolvedReconstructionObligationLedgerEvidence({
      ...resolved.value,
      manifest: {
        ...resolved.value.manifest,
        bindings: [...resolved.value.manifest.bindings, ...proof.bindings],
      },
      sources: { bundle: evidence, records },
    });
    ledger = reconstructionObligationLedgerSchema.parse(
      ledgerEvidence.normalized_result,
    );
    restoreQuery = { ...viewRequest, verification_evidence_id: verificationId };
    const verifiedView = inspectAnalysisViewValidated(
      {
        source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
        view: restoreQuery,
      },
      (id) => records.get(id),
    );
    if (!verifiedView.ok) return verifiedView;
    const result = analysisViewResultSchema.parse(
      verifiedView.value.normalized_result,
    );
    if (
      result.kind !== "legacy-journey" ||
      result.verification?.evidence_id !== verificationId
    )
      return err(
        new AnalysisOutputError(
          LEGACY_JOURNEY_OPERATION,
          "The admitted receipt could not be projected into its journey",
        ),
      );
    publishedView = verifiedView.value;
    publishedJourney = result;
    records.set(publishedView.evidence_id, publishedView);
  }
  records.set(ledgerEvidence.evidence_id, ledgerEvidence);
  const project = {
    manifest: characterized.value,
    journey: publishedJourney,
    evidence:
      request.export_directory === undefined
        ? evidence
        : createEvidenceBundle([...records.values()], evidence.unknowns),
    ledger,
    query: restoreQuery,
  };
  const obligations = selectedObligations();
  try {
    const publication =
      request.export_directory === undefined
        ? null
        : await writeLegacyJourneyProject(
            project,
            request.export_directory,
            resources,
            signal,
          );
    const result = legacyJourneyWorkflowResultSchema.parse({
      dossier_sha256: digestCanonicalValue(
        [
          characterized.value,
          publishedJourney.view_digest,
          ledger.closure_digest,
        ],
        "Legacy journey dossier",
      ),
      journey_id: journey.journey_id,
      view_evidence_id: publishedView.evidence_id,
      ledger_evidence_id: ledgerEvidence.evidence_id,
      source_comparison_evidence_id: comparisonId ?? null,
      coverage: characterized.value.coverage,
      obligations: obligations.map(
        ({ obligation_id, family, status, binding }) => ({
          obligation_id,
          family,
          status,
          verifier_status: binding?.verifier?.status ?? null,
        }),
      ),
      diagnostics: [
        ...publishedJourney.diagnostics,
        ...(characterized.value.comparison.state === "unavailable"
          ? [characterized.value.comparison.reason]
          : characterized.value.comparison.result.limitations),
      ],
      verification_evidence_id: verificationId,
      export: publication,
    });
    const dossier = createEvidence(
      unknownTarget("derived-from-linked-evidence"),
      JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER,
      {
        operation: LEGACY_JOURNEY_OPERATION,
        predicateType: "rea.legacy-journey-characterization",
        parameters: { journey_id: journey.journey_id },
        result,
        confidence: "inferred",
        authority: "analyst-inference",
        evidenceLinks: [
          publishedView.evidence_id,
          ledgerEvidence.evidence_id,
          ...(comparisonId === undefined ? [] : [comparisonId]),
          ...(verificationId === null ? [] : [verificationId]),
        ],
        limitations: publishedJourney.limitations,
      },
    );
    return ok({ evidence: dossier, sources: [...records.values()] });
  } catch (cause) {
    return err(
      cause instanceof AnalysisError
        ? cause
        : new AnalysisOutputError(
            LEGACY_JOURNEY_OPERATION,
            errorMessage(cause),
            { cause },
          ),
    );
  }
};

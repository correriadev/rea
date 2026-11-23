import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { equalJsonValues } from "../domain/jsonValue.js";
import { createEvidence } from "../domain/evidence.js";
import { JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER } from "../domain/investigationProviders.js";
import type { ReconstructionObligationManifest } from "../domain/reconstructionObligationLedgerSchemas.js";
import { unknownTarget } from "../domain/targetIdentity.js";
import {
  legacyJourneyReceiptSchema,
  type LegacyJourneyReceipt,
} from "../domain/legacyJourneyProject.js";
import { err, ok } from "../domain/result.js";
import { LEGACY_PERSISTENCE_CASES } from "./ReconstructionObligationPolicies.js";

type ReceiptCase = LegacyJourneyReceipt["cases"][number];
type Phase = LegacyJourneyReceipt["phases"][number];

const receiptError = (userMessage: string) =>
  err(new AnalysisInputError("admit_legacy_journey_receipt", { userMessage }));

const verifierId = "rea.legacy-journey";
const fixtureId = (family: string) => `rea.${family}`;
export const LEGACY_VERIFICATION_PREDICATE = "rea.reconstruction-proof";
export const LEGACY_VERIFICATION_OPERATION =
  "verify_reconstruction_obligations";

/** Convert an admitted caller-controlled run into exact ledger bindings. */
export const legacyJourneyReceiptProof = (
  receipt: LegacyJourneyReceipt,
  viewId: string,
) => {
  const completed = receipt.cases.flatMap((item) =>
    item.status === "unknown" ? [] : [{ ...item, status: item.status }],
  );
  const evidence = createEvidence(
    unknownTarget("derived-from-linked-evidence"),
    JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER,
    {
      operation: LEGACY_VERIFICATION_OPERATION,
      predicateType: LEGACY_VERIFICATION_PREDICATE,
      confidence: completed.length > 0 ? "observed" : "inferred",
      authority: "controlled-replay",
      parameters: {
        journey_view: viewId,
        candidate_sha256: receipt.candidate_sha256,
      },
      rawResult: receipt,
      result: {
        bindings: completed.map(
          ({ obligation_id, obligation_version, family, status }) => ({
            obligation_id,
            obligation_version,
            owner_sha256: receipt.candidate_sha256,
            fixtures: [
              {
                fixture_id: fixtureId(family),
                case_kind: "positive",
                passed: status === "pass",
              },
            ],
            verifiers: [
              {
                verifier_id: verifierId,
                claim_id: family,
                passed: status === "pass",
              },
            ],
          }),
        ),
      },
      evidenceLinks: [viewId],
      limitations: [
        "Receipt came from the caller. REA checks applicability and internal consistency. The selected driver supplies process and first-read observations.",
      ],
    },
  );
  const bindings: ReconstructionObligationManifest["bindings"] = completed.map(
    (item) => ({
      obligation_id: item.obligation_id,
      owner: {
        module_path: "candidate-build",
        symbol: receipt.journey_id,
        owner_sha256: receipt.candidate_sha256,
      },
      parser_type: null,
      original_cases: [
        {
          kind: "positive",
          evidence_id: evidence.evidence_id,
          location: `/raw_result/cases/${receipt.cases.findIndex(({ family }) => family === item.family)}`,
        },
      ],
      fixtures: [
        {
          fixture_id: fixtureId(item.family),
          case_kind: "positive",
          authority: "packaged-process",
          evidence_ids: [evidence.evidence_id],
        },
      ],
      verifier: {
        verifier_id: verifierId,
        claim_id: item.family,
        command: "node verify.mjs config.json result.json",
        authority: "packaged-process",
        status: item.status,
        result_evidence_id: evidence.evidence_id,
        enumerated_obligation_ids: [item.obligation_id],
        nondeterminism: {
          mode: "total-order",
          specification: "Distinct settled launches and ordered state samples",
        },
      },
    }),
  );
  return { evidence, bindings };
};

/** Bind external runner observations to the exact dossier and candidate. */
export const admitLegacyJourneyReceipt = (
  input: unknown,
  expected: {
    readonly journeyId: string;
    readonly baseline: string;
    readonly candidate: string;
    readonly obligations: readonly {
      readonly obligation_id: string;
      readonly obligation_version: number;
      readonly family: string;
    }[];
  },
) => {
  const parsed = legacyJourneyReceiptSchema.safeParse(input);
  if (!parsed.success) return receiptError("Malformed legacy journey receipt");
  const receipt = parsed.data;
  if (
    receipt.journey_id !== expected.journeyId ||
    receipt.build_sha256 !== expected.baseline ||
    receipt.candidate_sha256 !== expected.candidate ||
    receipt.build_sha256 === receipt.candidate_sha256
  )
    return receiptError(
      "Receipt does not match the selected journey and builds",
    );
  if (
    (receipt.cleanup === "incomplete") !==
      (receipt.residual_profile_root !== null) ||
    new Set(receipt.phases.map(({ process_identity }) => process_identity))
      .size !== receipt.phases.length
  )
    return receiptError(
      "Receipt contains inconsistent cleanup or process identity",
    );

  for (const { family } of LEGACY_PERSISTENCE_CASES) {
    const cases = receipt.cases.filter((item) => item.family === family);
    const obligation = expected.obligations.find(
      (item) => item.family === family,
    );
    const item = cases[0];
    if (
      cases.length !== 1 ||
      !item ||
      !obligation ||
      item.obligation_id !== obligation.obligation_id ||
      item.obligation_version !== obligation.obligation_version
    )
      return receiptError(
        "Receipt obligation identity or version differs from the dossier",
      );
    if (item.status === "unknown") continue;
    if (receipt.cleanup === "incomplete")
      return receiptError(
        "An unsettled execution cannot supply a pass or fail verdict",
      );
    const result = evaluateCase(receipt, item);
    if (result === undefined || (result ? "pass" : "fail") !== item.status)
      return receiptError(
        "Receipt verdict does not follow from its scoped observations",
      );
  }
  return ok(receipt);
};

const sameProfile = (a: Phase, b: Phase) =>
  a.profile === b.profile && a.profile_identity === b.profile_identity;

const sameFileSample = (a: Phase["after"], b: Phase["before"]) =>
  a.kind === "file" &&
  b.kind === "file" &&
  a.relative_path === b.relative_path &&
  a.identity === b.identity &&
  a.sha256 === b.sha256;

const persisted = (
  seed: Phase,
  reopened: Phase,
  receipt: LegacyJourneyReceipt,
) =>
  sameProfile(seed, reopened) &&
  seed.after.kind === "file" &&
  equalJsonValues(seed.value, receipt.seed) &&
  sameFileSample(seed.after, reopened.before) &&
  equalJsonValues(seed.value, reopened.value);

function evaluateCase(
  receipt: LegacyJourneyReceipt,
  item: ReceiptCase,
): boolean | undefined {
  const phases = receipt.phases;
  const old = receipt.build_sha256;
  const next = receipt.candidate_sha256;
  const pick = (index: number, build: string, action: Phase["action"]) => {
    const phase = phases[index];
    return phase?.build_sha256 === build && phase.action === action
      ? phase
      : undefined;
  };
  const oldClean = pick(0, old, "read-first");
  const newClean = pick(1, next, "read-first");
  if (
    !oldClean ||
    !newClean ||
    oldClean.profile === newClean.profile ||
    oldClean.profile_identity === newClean.profile_identity ||
    equalJsonValues(oldClean.value, receipt.seed) ||
    equalJsonValues(newClean.value, receipt.seed)
  )
    return undefined;
  if (item.family === "legacy-clean-start")
    return equalJsonValues(item.phases, [0, 1])
      ? oldClean.before.kind === "absent-file" &&
          newClean.before.kind === "absent-file" &&
          equalJsonValues(oldClean.value, newClean.value)
      : undefined;

  const oldSeed = pick(2, old, "seed");
  const nextSeed = pick(3, next, "seed");
  const oldRestart = pick(4, old, "read-first");
  const nextRestart = pick(5, next, "read-first");
  if (
    !oldSeed ||
    !nextSeed ||
    !oldRestart ||
    !nextRestart ||
    !sameProfile(oldClean, oldSeed) ||
    !sameProfile(newClean, nextSeed) ||
    !sameProfile(oldSeed, oldRestart) ||
    !sameProfile(nextSeed, nextRestart)
  )
    return undefined;
  if (item.family === "legacy-same-build-restart")
    return equalJsonValues(item.phases, [2, 4, 3, 5])
      ? persisted(oldSeed, oldRestart, receipt) &&
          persisted(nextSeed, nextRestart, receipt)
      : undefined;

  const upgrade = pick(6, next, "read-first");
  if (
    !upgrade ||
    !sameProfile(oldRestart, upgrade) ||
    !equalJsonValues(item.phases, [2, 4, 6])
  )
    return undefined;
  return (
    persisted(oldSeed, oldRestart, receipt) &&
    oldRestart.after.kind === "file" &&
    sameFileSample(oldRestart.after, upgrade.before) &&
    equalJsonValues(oldRestart.value, upgrade.value)
  );
}

/** Portable Node runner. The caller supplies the target-specific lifecycle driver. */
export const legacyJourneyRunner = String.raw`
import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const digestChunks = async (chunks) => {
  const hash = createHash("sha256");
  for await (const bytes of chunks) hash.update(bytes);
  return hash.digest("hex");
};
const digestFile = (path) => digestChunks(createReadStream(path));
const directoryIdentity = async (path) => {
  const entry = await lstat(path, { bigint: true });
  if (!entry.isDirectory() || await realpath(path) !== path)
    throw Error("Disposable directory was replaced");
  return String(entry.dev) + ":" + String(entry.ino);
};
const writeJson = (value) => JSON.stringify(value, null, 2) + "\n";
const caseNames = ["legacy-clean-start", "legacy-same-build-restart", "legacy-in-place-upgrade"];
const MAX_STATE_BYTES = 1_048_576;
const validExit = (value) => value && typeof value.process_identity === "string" &&
  value.process_identity.length > 0 && value.settled === true;
const xml = (value) => String(value).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

function selectedValue(bytes, selectors) {
  if (selectors === undefined) return undefined;
  let value;
  try {
    if (!isUtf8(bytes)) throw Error("Invalid UTF-8");
    value = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  }
  catch { return { kind: "unknown", reason: "State file is not valid UTF-8 JSON" }; }
  for (const key of selectors) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key))
      return { kind: "absent-member" };
    value = value[key];
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 16_384) return { kind: "unknown", reason: "Selected state value exceeds 16384 bytes" };
  return { kind: "value", value };
}

async function disk(profile, file, selectors) {
  const path = join(profile, file);
  let accessible;
  try { accessible = await realpath(path); }
  catch (error) {
    if (error.code === "ENOENT") return { kind: "absent-file" };
    throw error;
  }
  const location = relative(profile, accessible);
  if (!location || location === ".." || location.startsWith(".." + sep) ||
      isAbsolute(location)) throw Error("State file escaped the disposable profile");
  const entry = await lstat(path, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink()) throw Error("State witness must be a regular file");
  const handle = await open(accessible, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (before.ino !== entry.ino || before.dev !== entry.dev) throw Error("State witness identity changed");
    if (before.size > MAX_STATE_BYTES || !before.isFile()) throw Error("State witness exceeds its file allowance");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    const { bytesRead } = await handle.read(bytes);
    const after = await handle.stat({ bigint: true });
    const bound = await lstat(path, { bigint: true });
    if (BigInt(bytesRead) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs ||
        bound.ino !== after.ino || bound.dev !== after.dev || bound.isSymbolicLink())
      throw Error("State changed while it was sampled");
    const observed = bytes.subarray(0, bytesRead);
    return {
      kind: "file", relative_path: file, sha256: await digestChunks([observed]),
      identity: String(before.dev) + ":" + String(before.ino),
      selected_value: selectedValue(observed, selectors),
    };
  } finally {
    await handle.close();
  }
}

async function run(config, dossier) {
  if (!Array.isArray(dossier.cases) || !caseNames.every((name) =>
      dossier.cases.filter((entry) => entry.family === name).length === 1))
    throw Error("Project does not define the three required obligations");
  const timeout = config.timeout_ms ?? 30_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000)
    throw Error("timeout_ms must be an integer in 1..120000");
  const state = config.state_file;
  if (typeof state !== "string" || !state || /[\\/:]/.test(state) || state === "." || state === "..")
    throw Error("state_file must name one regular file in the disposable profile");
  const selectors = config.state_value_path;
  if (selectors !== undefined && (!Array.isArray(selectors) || selectors.length > 16 ||
      selectors.some((part) => typeof part !== "string" || part.length > 256)))
    throw Error("state_value_path must contain up to 16 JSON member names");
  const baseline = await realpath(config.baseline);
  const candidate = await realpath(config.candidate);
  const baseDigest = await digestFile(baseline);
  const nextDigest = await digestFile(candidate);
  if (baseDigest !== dossier.build_sha256 || nextDigest === baseDigest)
    throw Error("Expected the pinned legacy artifact and a distinct candidate build");
  if (!Object.hasOwn(config, "seed")) throw Error("Choose a nondefault seed for this journey");
  const { runPhase } = await import(pathToFileURL(resolve(config.driver)).href);
  if (typeof runPhase !== "function") throw Error("The selected driver must export runPhase");
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "rea-legacy-journey-")));
  const workspaceIdentity = await directoryIdentity(workspace);
  let ownsSettledProcesses = true;
  let cleanup = "complete";
  const usedProcesses = new Set();
  const phases = [];
  const cases = [];
  const launch = async (build, profile, action) => {
    const build_sha256 = build === baseline ? baseDigest : nextDigest;
    if (await digestFile(build) !== build_sha256) throw Error("The selected build changed");
    const profile_identity = await directoryIdentity(profile);
    const before = await disk(profile, state, selectors);
    const signal = AbortSignal.timeout(timeout);
    ownsSettledProcesses = false;
    const result = await runPhase({ build, profile, action, seed: config.seed, signal });
    ownsSettledProcesses = validExit(result);
    if (!ownsSettledProcesses) throw Error("Driver did not confirm process exit");
    if (signal.aborted) throw Error("Driver completed after its deadline");
    if (usedProcesses.has(result.process_identity)) throw Error("Driver reused a process identity");
    usedProcesses.add(result.process_identity);
    const property = action === "seed" ? "value_after_seed" : "first_read";
    if (!Object.hasOwn(result, property) || result[property] === undefined)
      throw Error("Driver did not return " + property);
    if (await directoryIdentity(profile) !== profile_identity) throw Error("Profile identity changed");
    if (await digestFile(build) !== build_sha256) throw Error("Build changed while the driver ran");
    const phase = {
      action, build_sha256, profile, profile_identity, process_identity: result.process_identity,
      before, after: await disk(profile, state, selectors), value: result[property],
      ...(action === "seed" && result.handler_reply !== undefined ? { handler_reply: result.handler_reply } : {}),
    };
    phases.push(phase);
    return phase;
  };
  try {
    const oldProfile = await realpath(await mkdtemp(join(workspace, "baseline-")));
    const newProfile = await realpath(await mkdtemp(join(workspace, "candidate-")));
    const oldClean = await launch(baseline, oldProfile, "read-first");
    const newClean = await launch(candidate, newProfile, "read-first");
    if (isDeepStrictEqual(oldClean.value, config.seed) || isDeepStrictEqual(newClean.value, config.seed))
      throw Error("The seed is indistinguishable from a clean start");
    const record = (family, observations, passed) => {
      const binding = dossier.cases.find((entry) => entry.family === family);
      cases.push({ ...binding, phases: observations.map((phase) => phases.indexOf(phase)), status: passed ? "pass" : "fail" });
    };
    record(caseNames[0], [oldClean, newClean],
      oldClean.before.kind === "absent-file" && newClean.before.kind === "absent-file" &&
      isDeepStrictEqual(oldClean.value, newClean.value));
    const oldSeed = await launch(baseline, oldProfile, "seed");
    const newSeed = await launch(candidate, newProfile, "seed");
    const oldRestart = await launch(baseline, oldProfile, "read-first");
    const newRestart = await launch(candidate, newProfile, "read-first");
    const persisted = (seed, reopened) => seed.after.kind === "file" &&
      seed.profile_identity === reopened.profile_identity &&
      isDeepStrictEqual(seed.value, config.seed) && isDeepStrictEqual(seed.after, reopened.before) &&
      isDeepStrictEqual(seed.value, reopened.value);
    record(caseNames[1], [oldSeed, oldRestart, newSeed, newRestart],
      persisted(oldSeed, oldRestart) && persisted(newSeed, newRestart));
    const upgraded = await launch(candidate, oldProfile, "read-first");
    record(caseNames[2], [oldSeed, oldRestart, upgraded],
      persisted(oldSeed, oldRestart) && oldRestart.profile_identity === upgraded.profile_identity &&
      oldRestart.after.kind === "file" &&
      isDeepStrictEqual(oldRestart.after, upgraded.before) && isDeepStrictEqual(oldRestart.value, upgraded.value));
  } catch (error) {
    const reason = String(error);
    for (const entry of dossier.cases)
      if (!cases.some(({ family }) => entry.family === family))
        cases.push({ ...entry, phases: [], status: "unknown", reason });
  } finally {
    try {
      if (!ownsSettledProcesses) throw Error("Driver did not settle");
      if (await directoryIdentity(workspace) !== workspaceIdentity) throw Error("Workspace identity changed");
      await rm(workspace, { recursive: true, force: true });
    } catch {
      cleanup = "incomplete";
      for (const entry of cases) {
        entry.status = "unknown";
        entry.reason = "Disposable profile cleanup is incomplete";
      }
    }
  }
  return {
    version: 1, journey_id: dossier.journey_id, build_sha256: baseDigest,
    candidate_sha256: nextDigest, seed: config.seed, cleanup,
    residual_profile_root: cleanup === "incomplete" ? workspace : null,
    phases, cases,
  };
}

const [configPath, outputPath] = process.argv.slice(2);
if (!configPath || !outputPath) throw Error("Usage: node verify.mjs config.json result.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const dossier = JSON.parse(await readFile(new URL("verification-plan.json", import.meta.url), "utf8"));
const result = await run(config, dossier);
await writeFile(outputPath, writeJson(result), { flag: "wx" });
const body = result.cases.map((entry) => "<testcase name=\"" + xml(entry.family) + "\">" +
  (entry.status === "pass" ? "" : entry.status === "fail" ? "<failure>Behavior differs</failure>" :
    "<skipped>" + xml(entry.reason) + "</skipped>") + "</testcase>").join("");
await writeFile(outputPath + ".junit.xml", "<testsuite name=\"Legacy journey\">" + body + "</testsuite>\n", { flag: "wx" });
await writeFile(outputPath + ".html", "<!doctype html><meta charset=\"utf-8\"><title>Legacy verification</title><pre>" +
  xml(writeJson(result)) + "</pre>\n", { flag: "wx" });
process.exitCode = result.cases.every(({ status }) => status === "pass") ? 0 : 1;
`;

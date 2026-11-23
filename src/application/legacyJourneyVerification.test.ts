import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { sha256Hex } from "../kernel/sha256Hex.js";
import {
  admitLegacyJourneyReceipt,
  legacyJourneyRunner,
} from "./legacyJourneyVerification.js";
import { LEGACY_PERSISTENCE_CASES } from "./ReconstructionObligationPolicies.js";

const execute = promisify(execFile);
const obligations = LEGACY_PERSISTENCE_CASES.map(({ family }) => ({
  family,
  obligation_id: `fixture.${family}`,
  obligation_version: 1,
}));
const expected = {
  journeyId: "settings",
  baseline: sha256Hex(Buffer.from("old build")),
  candidate: sha256Hex(Buffer.from("new build")),
  obligations,
};
const json = (input: unknown) => JSON.stringify(input);
const fixtureDriver = `
  import { randomUUID } from "node:crypto";
  import { readFile, writeFile } from "node:fs/promises";
  import { join } from "node:path";
  export async function runPhase({ profile, action, seed }) {
    const file = join(profile, "preferences.json");
    const launch = { process_identity: randomUUID(), settled: true };
    if (action === "seed") {
      await writeFile(file, JSON.stringify(seed));
      return { ...launch, handler_reply: "accepted", value_after_seed: seed };
    }
    const first_read = JSON.parse(await readFile(file, "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return JSON.stringify("wide");
    }));
    return { ...launch, first_read };
  }
`;

const runnerFixture = async (driver: string, timeout_ms?: number) => {
  const root = await createTestTempDirectory("rea-legacy-verification-");
  const config = {
    baseline: join(root, "old.asar"),
    candidate: join(root, "new.asar"),
    driver: join(root, "driver.mjs"),
    seed: "compact",
    state_file: "preferences.json",
    state_value_path: [],
    timeout_ms,
  };
  await Promise.all([
    writeFile(config.baseline, "old build"),
    writeFile(config.candidate, "new build"),
    writeFile(config.driver, driver),
    writeFile(join(root, "config.json"), json(config)),
    writeFile(join(root, "verify.mjs"), legacyJourneyRunner),
    writeFile(
      join(root, "verification-plan.json"),
      json({
        version: 1,
        journey_id: expected.journeyId,
        build_sha256: expected.baseline,
        cases: obligations,
      }),
    ),
  ]);
  const output = join(root, "result.json");
  const run = () =>
    execute(
      process.execPath,
      [join(root, "verify.mjs"), join(root, "config.json"), output],
      { env: { ...process.env, TMP: root, TEMP: root, TMPDIR: root } },
    );
  return { output, run };
};

describe("standalone legacy journey verifier", () => {
  it("runs the exported script and admits separate case results bound to both builds", async () => {
    const { output, run } = await runnerFixture(fixtureDriver);
    await run();
    const receipt = JSON.parse(await readFile(output, "utf8"));
    const submitted = admitLegacyJourneyReceipt(receipt, expected);
    if (!submitted.ok) throw submitted.error;
    const { cases, phases } = submitted.value;
    expect(cases.map(({ status }) => status)).toEqual(["pass", "pass", "pass"]);
    expect(phases[6]!.profile_identity).toBe(phases[2]!.profile_identity);
    expect(phases[6]!.profile_identity).not.toBe(phases[3]!.profile_identity);
    expect(phases[2]).toMatchObject({
      handler_reply: "accepted",
      after: { selected_value: { kind: "value", value: "compact" } },
    });
    expect(await readFile(output + ".junit.xml", "utf8")).toContain(
      "legacy-in-place-upgrade",
    );
    expect(await readFile(output + ".html", "utf8")).toContain(
      "profile_identity",
    );

    receipt.cases[2].phases = [2, 4, 5];
    expect(admitLegacyJourneyReceipt(receipt, expected).ok).toBe(false);
    receipt.cases[2].phases = [2, 4, 6];
    receipt.phases[6].profile_identity = receipt.phases[3].profile_identity;
    expect(admitLegacyJourneyReceipt(receipt, expected).ok).toBe(false);
  });

  it("records a deadline with no applicable proof and retains the root when exit is unconfirmed", async () => {
    const { output, run } = await runnerFixture(
      `
      import { setTimeout } from "node:timers/promises";
      export async function runPhase({ signal }) {
        await setTimeout(10_000, undefined, { signal });
      }
    `,
      20,
    );
    await expect(run()).rejects.toMatchObject({ code: 1 });
    const receipt = JSON.parse(await readFile(output, "utf8"));
    expect(receipt.cleanup).toBe("incomplete");
    expect(receipt.residual_profile_root).toEqual(expect.any(String));
    expect(
      receipt.cases.map(({ status }: { status: string }) => status),
    ).toEqual(["unknown", "unknown", "unknown"]);
    expect(admitLegacyJourneyReceipt(receipt, expected).ok).toBe(true);
    receipt.cases[0].status = "pass";
    expect(admitLegacyJourneyReceipt(receipt, expected).ok).toBe(false);
  });
});

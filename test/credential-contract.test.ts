import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderQuota, SourceAttempt } from "../src/types.js";

/**
 * The cross-provider invariant every multi-source adapter has to hold, checked
 * against the real adapters rather than one provider's hand-written fixture.
 *
 * `credentialPresent` is what makes a broken-but-superseded store visible as a
 * degraded source, and it is currently re-derived at each adapter's own call
 * sites. That is exactly how a present-but-structurally-invalid Pi entry once
 * read as absence in four separate files. This table fails when any provider
 * regresses either half of the rule:
 *
 *   absent store              -> no `credentialPresent`, nothing degraded
 *   present but not working   -> `credentialPresent: true`, degraded
 *
 * and when a stored-expired credential is skipped instead of probed.
 */

type PiProviderCase = {
  provider: "codex" | "kimi" | "grok";
  /** Property name Pi stores this provider's credential under. */
  piKey: string;
  /** Attempt source name the adapter reports for its Pi store. */
  piSource: string;
  /** A structurally complete, unexpired entry for this provider. */
  liveEntry: Record<string, unknown>;
};

const CASES: PiProviderCase[] = [
  {
    provider: "codex",
    piKey: "openai-codex",
    piSource: "pi:openai-codex",
    liveEntry: {
      type: "oauth",
      access: "pi-codex-probe-token",
      refresh: "must-not-be-read",
      expires: Date.now() + 3_600_000,
      accountId: "acct-contract-fixture",
    },
  },
  {
    provider: "kimi",
    piKey: "kimi-coding",
    piSource: "pi:kimi-coding",
    liveEntry: {
      type: "oauth",
      access: "pi-kimi-probe-token",
      refresh: "must-not-be-read",
      expires: Date.now() + 3_600_000,
    },
  },
  {
    provider: "grok",
    piKey: "xai",
    piSource: "pi:xai",
    liveEntry: {
      type: "oauth",
      access: "pi-xai-probe-token",
      refresh: "must-not-be-read",
      expires: Date.now() + 3_600_000,
    },
  },
];

/** Present-but-unusable Pi entries: none of these is an absent source. */
const BROKEN_ENTRIES: Array<[label: string, entry: unknown]> = [
  ["empty object", {}],
  ["null", null],
  ["array", []],
  ["scalar", "token"],
  ["unknown type", { type: "totally-unknown", access: "x" }],
];

const ENV_KEYS = [
  "CODEX_HOME",
  "QUOTA_AXI_CODEX_BINARY",
  "PI_CODING_AGENT_DIR",
  "KIMI_CODE_HOME",
  "GROK_HOME",
  "GROK_AUTH",
  "GROK_AUTH_JSON",
  "GROK_AUTH_PATH",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
] as const;

const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);
let tempDir: string;

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-credential-contract-"));
  // Every store points into the sandbox, so the machine's real credentials
  // never decide a result here.
  process.env.CODEX_HOME = join(tempDir, "codex");
  process.env.PI_CODING_AGENT_DIR = join(tempDir, "pi-agent");
  process.env.KIMI_CODE_HOME = join(tempDir, "kimi-code");
  process.env.GROK_HOME = join(tempDir, "grok");
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
  process.env.XDG_DATA_HOME = join(tempDir, "data");
  process.env.QUOTA_AXI_CODEX_BINARY = join(tempDir, "no-such-codex");
  delete process.env.GROK_AUTH;
  delete process.env.GROK_AUTH_JSON;
  delete process.env.GROK_AUTH_PATH;
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  vi.doMock("../src/lib/process.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/lib/process.js")>()),
    findCommandPath: vi.fn(async () => undefined),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../src/lib/process.js");
  vi.resetModules();
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function writePiStore(store: unknown): void {
  const dir = process.env.PI_CODING_AGENT_DIR!;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify(store), { mode: 0o600 });
}

/** Rejects every bearer, so only credential enrolment is under test here. */
function stubRejectingApi(): { bearers: string[] } {
  const bearers: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      bearers.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(null, { status: 401 });
    }),
  );
  return { bearers };
}

async function readQuota(provider: string): Promise<ProviderQuota> {
  const { PROVIDERS } = await import("../src/providers/index.js");
  return PROVIDERS[provider as keyof typeof PROVIDERS].fetchQuota({
    allowKeychainPrompt: false,
    refreshCredentials: false,
  });
}

const attemptsFor = (result: ProviderQuota, source: string): SourceAttempt[] =>
  (result.attempts ?? []).filter((attempt) => attempt.source === source);

describe("credential source contract", { timeout: 30_000 }, () => {
  describe.each(CASES)("$provider", (testCase) => {
    it("leaves an absent Pi entry unmarked, so nothing reads as degraded", async () => {
      // A store that exists but holds no entry for this provider: the machine
      // simply does not use Pi for it.
      writePiStore({ "some-other-provider": { type: "oauth" } });
      stubRejectingApi();

      const result = await readQuota(testCase.provider);

      for (const attempt of attemptsFor(result, testCase.piSource)) {
        expect(attempt.credentialPresent).toBeUndefined();
      }
    });

    it.each(BROKEN_ENTRIES)(
      "marks a present but broken Pi entry (%s) as a credential that exists",
      async (_label, entry) => {
        writePiStore({ [testCase.piKey]: entry });
        stubRejectingApi();

        const result = await readQuota(testCase.provider);
        const piAttempts = attemptsFor(result, testCase.piSource);

        expect(piAttempts.length).toBeGreaterThan(0);
        for (const attempt of piAttempts) {
          expect(attempt.credentialPresent).toBe(true);
        }
      },
    );

    it("probes a stored-expired Pi credential instead of skipping it", async () => {
      // Stored expiry is advisory ordering. The endpoint, not the `expires`
      // field, is the only thing allowed to produce an auth verdict.
      writePiStore({
        [testCase.piKey]: { ...testCase.liveEntry, expires: Date.now() - 1 },
      });
      const api = stubRejectingApi();

      await readQuota(testCase.provider);

      const token = testCase.liveEntry.access as string;
      expect(api.bearers).toContain(`Bearer ${token}`);
    });

    it("never claims no local credential for one the endpoint refused", async () => {
      // The safety half of the rule, and the one every provider owes: the
      // claim is about quota-axi's reach, so a credential that was found and
      // refused can never carry it whatever else the adapter reports.
      writePiStore({ [testCase.piKey]: testCase.liveEntry });
      stubRejectingApi();

      const result = await readQuota(testCase.provider);

      expect(result.state.reason).not.toBe("no_local_credential");
    });
  });

  /**
   * Routed through `localCredentialReason` so far. The remaining adapters
   * still report their empty-handed reads as a sign-out; they owe this reason
   * too, and the invariant above already stops any of them claiming it wrongly.
   */
  describe.each(["codex", "zai"])("%s with no store to read", (provider) => {
    it("reports that no credential was found, not that the account signed out", async () => {
      stubRejectingApi();

      const result = await readQuota(provider);

      expect(result.state.status).toBe("auth_required");
      expect(result.state.reason).toBe("no_local_credential");
      expect(result.state.error ?? "").not.toMatch(/sign-in|signed out/i);
    });
  });

  /**
   * The third state: a store did hold a credential, but in a shape no endpoint
   * could be shown. That is a stored-credential problem to fix, and it is
   * neither of the other two - not "quota-axi found none" and not a sign-out.
   */
  const UNUSABLE_STORES: Array<[provider: string, write: () => void]> = [
    [
      "codex",
      () =>
        writeFileSync(
          join(process.env.CODEX_HOME!, "auth.json"),
          JSON.stringify({ tokens: { access_token: 42 } }),
          { mode: 0o600 },
        ),
    ],
    [
      "zai",
      () => {
        const dir = join(process.env.XDG_DATA_HOME!, "opencode");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "auth.json"),
          JSON.stringify({ "zai-coding-plan": { type: "api", key: "   " } }),
          { mode: 0o600 },
        );
      },
    ],
  ];

  describe.each(UNUSABLE_STORES)(
    "%s with a store holding an unusable credential",
    (provider, write) => {
      it("reports the stored credential as unusable, not as absence or a sign-out", async () => {
        write();
        const api = stubRejectingApi();

        const result = await readQuota(provider);

        // Nothing sendable was found, so no endpoint was asked and no verdict
        // about the account exists to report.
        expect(api.bearers).toEqual([]);
        expect(result.state.status).toBe("auth_required");
        expect(result.state.reason).toBe("local_credential_unusable");
      });
    },
  );
});

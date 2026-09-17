import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };

const originalHome = process.env.HOME;
const originalUser = process.env.USER;
const originalUserProfile = process.env.USERPROFILE;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
let tempDir: string | undefined;

beforeEach(() => {
  vi.resetModules();
  usePlatform("linux");
  process.env.USER = "fixture-user";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../../src/lib/process.js");
  if (originalPlatform)
    Object.defineProperty(process, "platform", originalPlatform);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUser === undefined) delete process.env.USER;
  else process.env.USER = originalUser;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function usePlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

function useTempHome(): string {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-claude-catalog-"));
  process.env.HOME = tempDir;
  process.env.USERPROFILE = tempDir;
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
  return tempDir;
}

function writeCredentials(accessToken: string, expiresAt?: string): void {
  const home = process.env.HOME!;
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: { accessToken, ...(expiresAt ? { expiresAt } : {}) },
    }),
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** The `security -w` calls, which are the reads that can prompt on macOS. */
function keychainValueReads(execFileText: { mock: { calls: unknown[][] } }) {
  return execFileText.mock.calls.filter((call) =>
    (call[1] as string[]).includes("-w"),
  );
}

function listingRequests(fetchMock: { mock: { calls: unknown[][] } }) {
  return fetchMock.mock.calls.filter((call) =>
    String(call[0]).includes("/v1/models"),
  );
}

function usageRequests(fetchMock: { mock: { calls: unknown[][] } }) {
  return fetchMock.mock.calls.filter((call) =>
    String(call[0]).includes("/usage"),
  );
}

describe("normalizeClaudeModelCatalog", () => {
  it("keeps every record carrying the vendor's own id", async () => {
    const { normalizeClaudeModelCatalog } =
      await import("../../src/providers/claude.js");

    expect(
      normalizeClaudeModelCatalog({
        data: [
          { id: "claude-fable-5-1", display_name: "Claude Fable 5.1" },
          { id: "claude-opus-5", display_name: "Claude Opus 5" },
        ],
      }),
    ).toEqual([
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
      { id: "claude-opus-5", label: "Claude Opus 5" },
    ]);
  });

  it("falls back to the vendor id when no display name is given", async () => {
    const { normalizeClaudeModelCatalog } =
      await import("../../src/providers/claude.js");

    expect(
      normalizeClaudeModelCatalog({
        data: [
          { id: "claude-opus-5" },
          { id: "claude-sonnet-5", display_name: "  " },
        ],
      }),
    ).toEqual([
      { id: "claude-opus-5", label: "claude-opus-5" },
      { id: "claude-sonnet-5", label: "claude-sonnet-5" },
    ]);
  });

  it("drops records that are not objects or carry no id", async () => {
    const { normalizeClaudeModelCatalog } =
      await import("../../src/providers/claude.js");

    expect(
      normalizeClaudeModelCatalog({
        data: [
          null,
          "claude-opus-5",
          7,
          { display_name: "Nameless" },
          { id: "" },
        ],
      }),
    ).toEqual([]);
  });

  it("reads nothing from a payload with no model array", async () => {
    const { normalizeClaudeModelCatalog } =
      await import("../../src/providers/claude.js");

    expect(normalizeClaudeModelCatalog({ data: [] })).toEqual([]);
    expect(normalizeClaudeModelCatalog({})).toEqual([]);
    expect(normalizeClaudeModelCatalog(null)).toEqual([]);
    expect(normalizeClaudeModelCatalog("data")).toEqual([]);
  });
});

describe("Claude live model catalog", () => {
  it("reports the vendor's lineup from one read-only listing request", async () => {
    useTempHome();
    writeCredentials("live-token");
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [{ id: "claude-opus-5", display_name: "Claude Opus 5" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchModelCatalog } = await import("../../src/providers/claude.js");
    const catalog = await fetchModelCatalog(OPTIONS);

    expect(catalog).toMatchObject({
      provider: "claude",
      status: "live",
      models: [{ id: "claude-opus-5", label: "Claude Opus 5" }],
    });
    expect(catalog.status === "live" && catalog.truncated).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/models/);
    expect(init.method ?? "GET").toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("discloses a lineup the vendor said was not complete", async () => {
    useTempHome();
    writeCredentials("live-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: [{ id: "claude-opus-5", display_name: "Claude Opus 5" }],
          has_more: true,
          last_id: "claude-opus-5",
        }),
      ),
    );

    const { fetchModelCatalog } = await import("../../src/providers/claude.js");
    const catalog = await fetchModelCatalog(OPTIONS);

    expect(catalog).toMatchObject({ status: "live", truncated: true });
  });

  it("reports no credential without contacting the vendor", async () => {
    useTempHome();
    const fetchMock = vi.fn(async () => jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const { fetchModelCatalog } = await import("../../src/providers/claude.js");

    expect(await fetchModelCatalog(OPTIONS)).toEqual({
      provider: "claude",
      status: "unavailable",
      reason: "no_credential",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names the rejecting status rather than publishing a lineup", async () => {
    useTempHome();
    writeCredentials("stale-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );

    const { fetchModelCatalog } = await import("../../src/providers/claude.js");

    expect(await fetchModelCatalog(OPTIONS)).toEqual({
      provider: "claude",
      status: "unavailable",
      reason: "catalog_http_401",
    });
  });

  it("separates a timed-out listing from an unreachable one", async () => {
    useTempHome();
    writeCredentials("live-token");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const aborted = new Error("aborted");
        aborted.name = "AbortError";
        throw aborted;
      }),
    );
    const { fetchModelCatalog } = await import("../../src/providers/claude.js");
    expect(await fetchModelCatalog(OPTIONS)).toMatchObject({
      reason: "catalog_timeout",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ENOTFOUND");
      }),
    );
    expect(await fetchModelCatalog(OPTIONS)).toMatchObject({
      reason: "catalog_unreachable",
    });
  });

  it("reports an unrecognized payload instead of an empty lineup", async () => {
    useTempHome();
    writeCredentials("live-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ models: ["claude-opus-5"] })),
    );

    const { fetchModelCatalog } = await import("../../src/providers/claude.js");

    expect(await fetchModelCatalog(OPTIONS)).toMatchObject({
      status: "unavailable",
      reason: "catalog_unrecognized",
    });
  });

  /**
   * Regression: the listing read has to select the same credential the quota
   * read in the same run selects, or one account's model lineup gets joined to
   * another account's windows. On macOS the Keychain owns the session, so it is
   * read first even when the file token is still valid.
   */
  it("reads the credential the quota path owns before a valid sibling", async () => {
    usePlatform("darwin");
    useTempHome();
    writeCredentials("file-token", "2035-01-01T00:00:00.000Z");
    const execFileText = vi.fn(async () =>
      JSON.stringify({ claudeAiOauth: { accessToken: "keychain-token" } }),
    );
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [{ id: "claude-opus-5", display_name: "Claude Opus 5" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchModelCatalog } = await import("../../src/providers/claude.js");
    await fetchModelCatalog({
      allowKeychainPrompt: true,
      refreshCredentials: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer keychain-token",
    );
  });

  it.each([503, 403])(
    "stops at a non-definitive %i instead of promoting a sibling credential",
    async (status) => {
      usePlatform("darwin");
      useTempHome();
      writeCredentials("file-token");
      const execFileText = vi.fn(async () =>
        JSON.stringify({ claudeAiOauth: { accessToken: "keychain-token" } }),
      );
      vi.doMock("../../src/lib/process.js", () => ({ execFileText }));
      const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) =>
        (init.headers as Record<string, string>).authorization ===
        "Bearer keychain-token"
          ? new Response(null, { status })
          : jsonResponse({
              data: [{ id: "claude-opus-5", display_name: "Claude Opus 5" }],
            }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const { fetchModelCatalog } =
        await import("../../src/providers/claude.js");
      const catalog = await fetchModelCatalog({
        allowKeychainPrompt: true,
        refreshCredentials: false,
      });

      expect(catalog).toEqual({
        provider: "claude",
        status: "unavailable",
        reason: `catalog_http_${status}`,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  /**
   * Regression: the lineup read resolved the credential independently of the
   * quota read, so `models` read the macOS Keychain value twice in one command
   * - prompting again unless the user chose "Always Allow" - and the two reads
   * could answer from different accounts.
   */
  it("resolves the credential once across a run's quota and lineup reads", async () => {
    usePlatform("darwin");
    useTempHome();
    const execFileText = vi.fn(async () =>
      JSON.stringify({ claudeAiOauth: { accessToken: "keychain-token" } }),
    );
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) =>
        String(url).includes("/v1/models")
          ? jsonResponse({
              data: [{ id: "claude-opus-5", display_name: "Claude Opus 5" }],
            })
          : jsonResponse({
              five_hour: { utilization: 10, resets_at: "2035-01-01T00:00:00Z" },
            }),
      ),
    );

    const { createProviderCredentialCache } =
      await import("../../src/providers/credential-cache.js");
    const { fetchModelCatalog, fetchQuota } =
      await import("../../src/providers/claude.js");
    const options = {
      allowKeychainPrompt: true,
      refreshCredentials: false,
      credentialCache: createProviderCredentialCache(),
    };

    const quota = await fetchQuota(options);
    const catalog = await fetchModelCatalog(options);

    expect(quota.state.status).toBe("fresh");
    expect(catalog).toMatchObject({ status: "live" });
    expect(keychainValueReads(execFileText)).toHaveLength(1);
  });

  /**
   * The rejection case itself, with nothing else moving: the store is never
   * rewritten between the two reads, and the listing endpoint would answer any
   * bearer at all. The only way the lineup read can come back without a lineup
   * is by withholding the credential Anthropic just rejected.
   *
   * This is deliberately not the external-rotation case. A cache that only
   * dropped its resolution on a rejection would re-read the unchanged store,
   * resolve the identical rejected token, and present it here a second time.
   */
  it("withholds from the lineup read a credential the quota read watched Anthropic reject", async () => {
    useTempHome();
    writeCredentials("rejected-token");
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url).includes("/v1/models")
        ? jsonResponse({
            data: [{ id: "claude-opus-5", display_name: "Claude Opus 5" }],
          })
        : new Response(null, { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { createProviderCredentialCache } =
      await import("../../src/providers/credential-cache.js");
    const { fetchModelCatalog, fetchQuota } =
      await import("../../src/providers/claude.js");
    const options = {
      allowKeychainPrompt: false,
      refreshCredentials: false,
      credentialCache: createProviderCredentialCache(),
    };

    const quota = await fetchQuota(options);
    expect(quota.state.status).toBe("auth_required");

    expect(await fetchModelCatalog(options)).toEqual({
      provider: "claude",
      status: "unavailable",
      reason: "credential_rejected_this_run",
    });
    // Withheld, not merely unsuccessful: the listing endpoint never saw it.
    expect(listingRequests(fetchMock)).toHaveLength(0);
  });

  /**
   * Only Anthropic's own definitive rejection may latch. A 403 comes back for
   * perfectly valid bearers behind a network policy or WAF, so a credential
   * that saw one is not closed for the rest of the run.
   */
  it.each([
    ["403", 403],
    ["503", 503],
  ])(
    "keeps presenting a credential an HTTP %s never disproved",
    async (_label, status) => {
      useTempHome();
      writeCredentials("undisproven-token");
      const fetchMock = vi.fn(async (url: unknown) =>
        String(url).includes("/v1/models")
          ? jsonResponse({
              data: [{ id: "claude-opus-5", display_name: "Claude Opus 5" }],
            })
          : new Response(null, { status }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const { createProviderCredentialCache } =
        await import("../../src/providers/credential-cache.js");
      const { fetchModelCatalog, fetchQuota } =
        await import("../../src/providers/claude.js");
      const options = {
        allowKeychainPrompt: false,
        refreshCredentials: false,
        credentialCache: createProviderCredentialCache(),
      };

      await fetchQuota(options);

      expect(await fetchModelCatalog(options)).toMatchObject({
        status: "live",
        models: [{ id: "claude-opus-5", label: "Claude Opus 5" }],
      });
      expect(listingRequests(fetchMock)).toHaveLength(1);
    },
  );

  /**
   * The latch is on the credential, not on Claude as a provider: a sibling
   * store the vendor never rejected still answers the lineup read, and it does
   * so from the resolution the quota read already paid for.
   */
  it("still offers a sibling credential the rejection did not cover", async () => {
    usePlatform("darwin");
    useTempHome();
    writeCredentials("file-token");
    const execFileText = vi.fn(async () =>
      JSON.stringify({ claudeAiOauth: { accessToken: "rejected-token" } }),
    );
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));
    const fetchMock = vi.fn(async (url: unknown, init: RequestInit) => {
      const live =
        (init.headers as Record<string, string>).authorization ===
        "Bearer file-token";
      if (!live) return new Response(null, { status: 401 });
      return String(url).includes("/v1/models")
        ? jsonResponse({
            data: [{ id: "claude-opus-5", display_name: "Claude Opus 5" }],
          })
        : jsonResponse({
            five_hour: { utilization: 10, resets_at: "2035-01-01T00:00:00Z" },
          });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { createProviderCredentialCache } =
      await import("../../src/providers/credential-cache.js");
    const { fetchModelCatalog, fetchQuota } =
      await import("../../src/providers/claude.js");
    const options = {
      allowKeychainPrompt: true,
      refreshCredentials: false,
      credentialCache: createProviderCredentialCache(),
    };

    expect((await fetchQuota(options)).state.status).toBe("fresh");
    expect(await fetchModelCatalog(options)).toMatchObject({ status: "live" });
    // The rejected Keychain credential is skipped outright, so the listing
    // endpoint is asked exactly once, with the credential that works.
    expect(listingRequests(fetchMock)).toHaveLength(1);
    expect(keychainValueReads(execFileText)).toHaveLength(1);
  });

  /**
   * Regression: the latch was consulted once before the candidate loop, so two
   * stores holding the identical token still produced two identical 401s in
   * one pass. Consulting it per candidate withholds the second one.
   */
  it("sends one 401 when both Claude stores hold the same token", async () => {
    usePlatform("darwin");
    useTempHome();
    writeCredentials("shared-token");
    const execFileText = vi.fn(async () =>
      JSON.stringify({ claudeAiOauth: { accessToken: "shared-token" } }),
    );
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const { createProviderCredentialCache } =
      await import("../../src/providers/credential-cache.js");
    const { fetchModelCatalog, fetchQuota } =
      await import("../../src/providers/claude.js");
    const options = {
      allowKeychainPrompt: true,
      refreshCredentials: false,
      credentialCache: createProviderCredentialCache(),
    };

    const quota = await fetchQuota(options);

    expect(usageRequests(fetchMock)).toHaveLength(1);
    expect(quota.attempts).toContainEqual({
      source: "oauth-file",
      status: "skipped",
      error: "credential_rejected_this_run",
      credentialPresent: true,
    });
    // Withheld, never absent: Anthropic's own verdict still stands.
    expect(quota.state.status).toBe("auth_required");
    expect(quota.state.error).toBe("Claude sign-in required");

    expect(await fetchModelCatalog(options)).toEqual({
      provider: "claude",
      status: "unavailable",
      reason: "credential_rejected_this_run",
    });
    expect(listingRequests(fetchMock)).toHaveLength(0);
  });

  /**
   * The same shape with no prior quota read: the listing loop itself must not
   * present a token its own earlier candidate just saw rejected.
   */
  it("asks the listing endpoint once when both stores hold the same token", async () => {
    usePlatform("darwin");
    useTempHome();
    writeCredentials("shared-token");
    const execFileText = vi.fn(async () =>
      JSON.stringify({ claudeAiOauth: { accessToken: "shared-token" } }),
    );
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const { createProviderCredentialCache } =
      await import("../../src/providers/credential-cache.js");
    const { fetchModelCatalog } = await import("../../src/providers/claude.js");

    expect(
      await fetchModelCatalog({
        allowKeychainPrompt: true,
        refreshCredentials: false,
        credentialCache: createProviderCredentialCache(),
      }),
    ).toEqual({
      provider: "claude",
      status: "unavailable",
      reason: "catalog_http_401",
    });
    expect(listingRequests(fetchMock)).toHaveLength(1);
  });

  it("reads the store again for each read when no cache is shared", async () => {
    usePlatform("darwin");
    useTempHome();
    const execFileText = vi.fn(async () =>
      JSON.stringify({ claudeAiOauth: { accessToken: "keychain-token" } }),
    );
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) =>
        String(url).includes("/v1/models")
          ? jsonResponse({
              data: [{ id: "claude-opus-5", display_name: "Claude Opus 5" }],
            })
          : jsonResponse({
              five_hour: { utilization: 10, resets_at: "2035-01-01T00:00:00Z" },
            }),
      ),
    );

    const { fetchModelCatalog, fetchQuota } =
      await import("../../src/providers/claude.js");
    const options = { allowKeychainPrompt: true, refreshCredentials: false };

    await fetchQuota(options);
    await fetchModelCatalog(options);

    expect(keychainValueReads(execFileText)).toHaveLength(2);
  });

  it("falls through to a sibling credential source after a rejection", async () => {
    usePlatform("darwin");
    useTempHome();
    writeCredentials("file-token");
    const execFileText = vi.fn(async () =>
      JSON.stringify({ claudeAiOauth: { accessToken: "rejected-token" } }),
    );
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) =>
      (init.headers as Record<string, string>).authorization ===
      "Bearer file-token"
        ? jsonResponse({
            data: [{ id: "claude-opus-5", display_name: "Claude Opus 5" }],
          })
        : new Response(null, { status: 401 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchModelCatalog } = await import("../../src/providers/claude.js");
    const catalog = await fetchModelCatalog({
      allowKeychainPrompt: true,
      refreshCredentials: false,
    });

    expect(catalog).toMatchObject({
      status: "live",
      models: [{ id: "claude-opus-5", label: "Claude Opus 5" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

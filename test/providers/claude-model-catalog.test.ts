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

  it("falls through to a sibling credential source after a rejection", async () => {
    usePlatform("darwin");
    useTempHome();
    writeCredentials("rejected-token");
    const execFileText = vi.fn(async () =>
      JSON.stringify({ claudeAiOauth: { accessToken: "keychain-token" } }),
    );
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) =>
      (init.headers as Record<string, string>).authorization ===
      "Bearer keychain-token"
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

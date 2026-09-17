import { afterEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { PROVIDERS } from "../src/providers/index.js";
import type { ProviderAdapter, ProviderQuota } from "../src/types.js";

const originalClaude = PROVIDERS.claude;
const originalCodex = PROVIDERS.codex;
const originalCursor = PROVIDERS.cursor;
const originalCopilot = PROVIDERS.copilot;
const originalGrok = PROVIDERS.grok;
const originalKimi = PROVIDERS.kimi;

afterEach(() => {
  PROVIDERS.claude = originalClaude;
  PROVIDERS.codex = originalCodex;
  PROVIDERS.cursor = originalCursor;
  PROVIDERS.copilot = originalCopilot;
  PROVIDERS.grok = originalGrok;
  PROVIDERS.kimi = originalKimi;
  process.exitCode = undefined;
});

describe("models command", () => {
  it("emits filtered JSON model evidence and compact TOON", async () => {
    // This adapter exposes no live catalog, so every row here is explicitly the
    // disclosed `unverified_builtin` fallback rather than a vendor lineup.
    PROVIDERS.claude = adapter({
      provider: "claude",
      label: "Claude",
      source: "oauth",
      windows: [
        {
          id: "model:fable",
          label: "Fable week",
          kind: "model",
          percentUsed: 20,
          percentRemaining: 80,
          modelScope: { id: "model:fable", name: "Fable", period: "weekly" },
        },
      ],
      state: { status: "fresh", stale: false, sourcesTried: ["oauth"] },
    });

    const json = JSON.parse(
      await capture([
        "models",
        "--provider",
        "claude",
        "--intelligence",
        "high",
        "--json",
      ]),
    );
    expect(json).toMatchObject({
      schemaVersion: 2,
      intelligenceCatalog: {
        version: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      },
      catalogSources: [
        {
          provider: "claude",
          status: "unavailable",
          reason: "no_live_catalog_source",
        },
      ],
      unmatchedWindowIds: ["claude/model:fable"],
    });
    expect(json.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "claude",
          id: "claude-opus-4-5",
          identitySource: "unverified_builtin",
          intelligence: "high",
          quotaScopes: [],
          state: { status: "fresh", stale: false },
        }),
      ]),
    );
    expect(json.models).toHaveLength(2);

    const sorted = JSON.parse(
      await capture([
        "models",
        "--provider",
        "claude",
        "--sort",
        "runway",
        "--json",
      ]),
    );
    expect(sorted.sort).toMatchObject({ key: "runway" });
    expect(sorted.sort.tieGroups).toContainEqual([
      { provider: "claude", id: "claude-haiku-4-5" },
      { provider: "claude", id: "claude-opus-4-5" },
      { provider: "claude", id: "claude-sonnet-4-5" },
    ]);

    const toon = await capture(["models", "--provider", "claude"]);
    expect(toon).toContain("models[");
    expect(toon).toContain("claude-opus-4-5");
    expect(toon).toContain(
      "Default model order is deterministic and non-preferential",
    );
  });

  /**
   * Regression: the built-in catalog pinned Claude's `model:fable` window to
   * `claude-opus-4-5`, so the join told readers a Fable-scoped window belonged
   * to Opus. Identity now comes from the vendor's own lineup, which names Fable
   * and Opus as different models.
   */
  it("attributes a model window using the provider's live catalog, not the built-in lineup", async () => {
    PROVIDERS.claude = liveCatalogAdapter(fableQuota(), [
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
      { id: "claude-opus-4-5-20251101", label: "Claude Opus 4.5" },
    ]);

    const json = JSON.parse(
      await capture(["models", "--provider", "claude", "--json"]),
    );

    const fable = json.models.find(
      (model: { id: string }) => model.id === "claude-fable-5-1",
    );
    expect(fable).toMatchObject({
      identitySource: "live_catalog",
      quotaScopes: ["model:fable"],
    });

    const opus = json.models.find(
      (model: { id: string }) => model.id === "claude-opus-4-5-20251101",
    );
    expect(opus.quotaScopes).not.toContain("model:fable");

    // The stale built-in id is not a model the vendor listed, so it is gone.
    expect(
      json.models.some(
        (model: { id: string }) => model.id === "claude-opus-4-5",
      ),
    ).toBe(false);
    expect(json.catalogSources).toEqual([
      {
        provider: "claude",
        status: "live",
        fetchedAt: "2026-09-17T12:00:00.000Z",
        modelCount: 2,
      },
    ]);
  });

  /**
   * Regression: Claude slugifies an id-less limit's display name, so
   * "Claude Opus 4.5" becomes `model:claude_opus_4_5`. A reader that took that
   * id apart stripped the trailing `_5` as a duplicate counter, turning the
   * window into `claude_opus_4` and publishing Opus 4.5's bound as Opus 4's.
   * The vendor's own display name is carried instead, so nothing is stripped.
   */
  it("keeps a slugified versioned window off the vendor's earlier version", async () => {
    PROVIDERS.claude = liveCatalogAdapter(
      {
        provider: "claude",
        label: "Claude",
        source: "oauth",
        windows: [
          {
            id: "model:claude_opus_4_5",
            label: "Claude Opus 4.5 week",
            kind: "model",
            percentUsed: 20,
            percentRemaining: 80,
            modelScope: {
              id: "model:claude_opus_4_5",
              name: "Claude Opus 4.5",
              period: "weekly",
            },
          },
        ],
        state: { status: "fresh", stale: false, sourcesTried: ["oauth"] },
      },
      [
        { id: "claude-opus-4-20250514", label: "Claude Opus 4" },
        { id: "claude-opus-4-5-20251101", label: "Claude Opus 4.5" },
      ],
    );

    const json = JSON.parse(
      await capture(["models", "--provider", "claude", "--json"]),
    );
    const byId = new Map(
      json.models.map((model: { id: string }) => [model.id, model]),
    );
    expect(byId.get("claude-opus-4-20250514").quotaScopes).not.toContain(
      "model:claude_opus_4_5",
    );
    expect(byId.get("claude-opus-4-5-20251101").quotaScopes).toEqual([
      "model:claude_opus_4_5",
    ]);
  });

  it("never invents an intelligence bucket for a model the catalog has not reviewed", async () => {
    PROVIDERS.claude = liveCatalogAdapter(fableQuota(), [
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
      // The built-in catalog knows `claude-sonnet-4-5`; the vendor ships it
      // under a dated id, which is the same model and keeps its bucket.
      { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
    ]);

    const json = JSON.parse(
      await capture(["models", "--provider", "claude", "--json"]),
    );
    const byId = new Map(
      json.models.map((model: { id: string }) => [model.id, model]),
    );
    expect(byId.get("claude-fable-5-1").intelligence).toBeUndefined();
    expect(byId.get("claude-sonnet-4-5-20250929").intelligence).toBe("high");
  });

  it("discloses an unreadable live catalog in both TOON and JSON", async () => {
    PROVIDERS.claude = {
      ...adapter(fableQuota()),
      async fetchModelCatalog() {
        return {
          provider: "claude" as const,
          status: "unavailable" as const,
          reason: "catalog_http_503",
        };
      },
    };

    const json = JSON.parse(
      await capture(["models", "--provider", "claude", "--json"]),
    );
    expect(json.catalogSources).toEqual([
      { provider: "claude", status: "unavailable", reason: "catalog_http_503" },
    ]);
    for (const model of json.models) {
      expect(model.identitySource).toBe("unverified_builtin");
    }

    const toon = await capture(["models", "--provider", "claude"]);
    expect(toon).toContain("catalog_http_503");
    expect(toon).toMatch(/claude-opus-4-5,[^\n]*,unverified,/);
  });

  it("falls back to disclosure when the live catalog read throws", async () => {
    PROVIDERS.claude = {
      ...adapter(fableQuota()),
      async fetchModelCatalog(): Promise<never> {
        throw new Error("socket hang up");
      },
    };

    const json = JSON.parse(
      await capture(["models", "--provider", "claude", "--json"]),
    );
    expect(json.catalogSources).toEqual([
      {
        provider: "claude",
        status: "unavailable",
        reason: "catalog_unreachable",
      },
    ]);
  });

  it("discloses a live lineup the vendor said was not complete", async () => {
    PROVIDERS.claude = {
      ...adapter(fableQuota()),
      async fetchModelCatalog() {
        return {
          provider: "claude" as const,
          status: "live" as const,
          fetchedAt: "2026-09-17T12:00:00.000Z",
          models: [{ id: "claude-fable-5-1", label: "Claude Fable 5.1" }],
          truncated: true,
        };
      },
    };

    const json = JSON.parse(
      await capture(["models", "--provider", "claude", "--json"]),
    );
    expect(json.catalogSources).toEqual([
      {
        provider: "claude",
        status: "live",
        fetchedAt: "2026-09-17T12:00:00.000Z",
        modelCount: 1,
        reason: "partial_lineup",
      },
    ]);

    const toon = await capture(["models", "--provider", "claude"]);
    expect(toon).toContain("partial_lineup");
  });

  /**
   * Regression: reading the lineup concurrently with quota used the credential
   * store as it was before the quota path refreshed it, so a refreshable
   * account reported an unreadable catalog and fell back to built-in rows.
   */
  it("reads the live lineup only after the quota read has settled", async () => {
    const order: string[] = [];
    PROVIDERS.claude = {
      ...adapter(fableQuota()),
      async fetchQuota() {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("quota");
        return fableQuota();
      },
      async fetchModelCatalog() {
        order.push("catalog");
        return {
          provider: "claude" as const,
          status: "live" as const,
          fetchedAt: "2026-09-17T12:00:00.000Z",
          models: [{ id: "claude-fable-5-1", label: "Claude Fable 5.1" }],
        };
      },
    };

    await capture(["models", "--provider", "claude", "--json"]);

    expect(order).toEqual(["quota", "catalog"]);
  });

  /**
   * Regression: Codex renames a repeated window to `<id>_<n>`, so a deduplicated
   * model window arrives as `model:gpt-5.1-codex:5h_2`. The repeat shares the
   * scope it repeats, which the adapter states outright; a reader that had to
   * recover the counter from the id published an attributed window as
   * unaccounted for instead.
   */
  it("keeps a deduplicated Codex model window on the scope it repeats", async () => {
    PROVIDERS.codex = adapter({
      provider: "codex",
      label: "Codex",
      source: "oauth",
      windows: [
        {
          id: "model:gpt-5.1-codex:5h",
          label: "GPT-5.1-Codex session",
          kind: "model",
          percentUsed: 10,
          percentRemaining: 90,
          modelScope: {
            id: "model:gpt-5.1-codex",
            name: "gpt-5.1-codex",
            period: "session",
          },
        },
        {
          id: "model:gpt-5.1-codex:5h_2",
          label: "GPT-5.1-Codex session",
          kind: "model",
          percentUsed: 20,
          percentRemaining: 80,
          modelScope: {
            id: "model:gpt-5.1-codex",
            name: "gpt-5.1-codex",
            period: "session",
            occurrence: 2,
          },
        },
      ],
      state: { status: "fresh", stale: false, sourcesTried: ["oauth"] },
    });

    const json = JSON.parse(
      await capture(["models", "--provider", "codex", "--json"]),
    );

    expect(json.unmatchedWindowIds ?? []).not.toContain(
      "codex/model:gpt-5.1-codex:5h_2",
    );
    const codex = json.models.find(
      (model: { id: string }) => model.id === "gpt-5.1-codex",
    );
    expect(codex.quotaScopes).toEqual(["model:gpt-5.1-codex"]);
  });

  it("discloses a built-in window attribution the vendor never confirmed", async () => {
    PROVIDERS.codex = adapter({
      provider: "codex",
      label: "Codex",
      source: "oauth",
      windows: [
        {
          id: "model:codex_bengalfox:7d",
          label: "codex_bengalfox week",
          kind: "model",
          percentUsed: 20,
          percentRemaining: 80,
          modelScope: {
            id: "model:codex_bengalfox",
            name: "codex_bengalfox",
            period: "weekly",
          },
        },
      ],
      state: { status: "fresh", stale: false, sourcesTried: ["oauth"] },
    });

    const json = JSON.parse(
      await capture(["models", "--provider", "codex", "--json"]),
    );
    const spark = json.models.find(
      (model: { id: string }) => model.id === "gpt-5.3-codex",
    );
    expect(spark.quotaScopes).toEqual(["model:codex_bengalfox"]);
    expect(json.unverifiedAttributions).toContainEqual({
      provider: "codex",
      windowId: "model:codex_bengalfox",
      modelId: "gpt-5.3-codex",
    });

    const toon = await capture(["models", "--provider", "codex"]);
    expect(toon).toContain("unverifiedAttributions[");
    expect(toon).toContain("model:codex_bengalfox");
  });

  /**
   * Regression: Anthropic's Opus week arrives as `seven_day_opus`, a window id
   * with no `model:` prefix, so a reader that recovered scope from the id could
   * not reach it at all. Every Opus row then reported the account-wide
   * remaining and overstated the headroom the Opus bound actually leaves.
   */
  it("binds Opus rows to Anthropic's Opus week, not the account remaining", async () => {
    PROVIDERS.claude = liveCatalogAdapter(opusWeekQuota(), [
      { id: "claude-opus-4-5-20251101", label: "Claude Opus 4.5" },
      { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
    ]);

    const json = JSON.parse(
      await capture(["models", "--provider", "claude", "--json"]),
    );
    const byId = new Map(
      json.models.map((model: { id: string }) => [model.id, model]),
    );

    expect(byId.get("claude-opus-4-5-20251101")).toMatchObject({
      quotaScopes: ["seven_day_opus"],
      effective: { scope: "seven_day_opus", effectivePercentRemaining: 0 },
    });
    // A model the Opus window does not name keeps the account evidence.
    expect(byId.get("claude-sonnet-4-5-20250929")).toMatchObject({
      quotaScopes: ["all_models"],
      effective: { scope: "all_models", effectivePercentRemaining: 80 },
    });
    expect(json.unmatchedWindowIds ?? []).not.toContain(
      "claude/seven_day_opus",
    );
  });

  it("keeps a live provider's rows out of another provider's buckets", async () => {
    PROVIDERS.claude = liveCatalogAdapter(fableQuota(), [
      { id: "claude-spark-1", label: "GPT-5.3-Codex-Spark" },
    ]);

    const json = JSON.parse(
      await capture(["models", "--provider", "claude", "--json"]),
    );
    const row = json.models.find(
      (model: { id: string }) => model.id === "claude-spark-1",
    );
    expect(row.intelligence).toBeUndefined();
  });

  it("rejects unsupported model filters and comparators as usage errors", async () => {
    const intelligence = await capture([
      "models",
      "--intelligence",
      "frontier",
    ]);
    expect(intelligence).toContain(
      "--intelligence requires high, medium, or low",
    );
    expect(process.exitCode).toBe(2);

    process.exitCode = undefined;
    const sort = await capture(["models", "--sort", "cost"]);
    expect(sort).toContain("Supported sort keys: runway");
    expect(process.exitCode).toBe(2);
  });

  it("fetches repeated provider scopes once and emits distinct unmatched scopes", async () => {
    let fetches = 0;
    const quota: ProviderQuota = {
      provider: "claude",
      label: "Claude",
      source: "oauth",
      windows: [
        {
          id: "model:unmapped",
          label: "Unmapped",
          kind: "model",
          modelScope: { id: "model:unmapped", name: "unmapped" },
        },
      ],
      state: { status: "fresh", stale: false, sourcesTried: ["oauth"] },
    };
    PROVIDERS.claude = {
      ...adapter(quota),
      async fetchQuota() {
        fetches++;
        return quota;
      },
    };

    const json = JSON.parse(
      await capture(["models", "--provider", "claude,claude", "--json"]),
    );
    expect(fetches).toBe(1);
    expect(json.unmatchedWindowIds).toEqual(["claude/model:unmapped"]);
  });

  it("fails when every catalog provider fails and rejects non-catalog scopes", async () => {
    for (const provider of ["claude", "codex", "grok", "kimi"] as const) {
      PROVIDERS[provider] = adapter(failedQuota(provider));
    }
    PROVIDERS.cursor = adapter({
      provider: "cursor",
      label: "Cursor",
      source: "api",
      windows: [],
      state: { status: "fresh", stale: false, sourcesTried: ["api"] },
    });

    const json = JSON.parse(await capture(["models", "--json"]));
    expect(json.models).toHaveLength(12);
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    const unsupported = await capture(["models", "--provider", "cursor"]);
    expect(unsupported).toContain("models does not support provider: cursor");
    expect(process.exitCode).toBe(2);
  });
});

async function capture(argv: string[]): Promise<string> {
  const chunks: string[] = [];
  await main({
    argv,
    binPath: "quota-axi",
    stdout: { write: (chunk) => chunks.push(String(chunk)) },
  });
  return chunks.join("");
}

function adapter(quota: ProviderQuota): ProviderAdapter {
  return {
    id: quota.provider,
    label: quota.label,
    async fetchQuota() {
      return quota;
    },
    async inspectAuth() {
      return { provider: quota.provider, sources: [] };
    },
  };
}

function failedQuota(
  provider: "claude" | "codex" | "grok" | "kimi",
): ProviderQuota {
  return {
    provider,
    label: provider,
    source: "unavailable",
    windows: [],
    state: {
      status: "unavailable",
      stale: false,
      sourcesTried: ["unavailable"],
    },
  };
}

function liveCatalogAdapter(
  quota: ProviderQuota,
  models: { id: string; label: string }[],
): ProviderAdapter {
  return {
    ...adapter(quota),
    async fetchModelCatalog() {
      return {
        provider: quota.provider,
        status: "live" as const,
        fetchedAt: "2026-09-17T12:00:00.000Z",
        models,
      };
    },
  };
}

/**
 * A Claude reading from the fixed top-level fields, where the Opus week is
 * spent while the account windows still report allowance.
 */
function opusWeekQuota(): ProviderQuota {
  return {
    provider: "claude",
    label: "Claude",
    source: "oauth",
    windows: [
      {
        id: "five_hour",
        label: "session",
        kind: "session",
        percentUsed: 10,
        percentRemaining: 90,
      },
      {
        id: "seven_day",
        label: "week",
        kind: "weekly",
        percentUsed: 20,
        percentRemaining: 80,
      },
      {
        id: "seven_day_opus",
        label: "opus week",
        kind: "model",
        percentUsed: 100,
        percentRemaining: 0,
        modelScope: { id: "seven_day_opus", name: "Opus", period: "weekly" },
      },
    ],
    state: { status: "fresh", stale: false, sourcesTried: ["oauth"] },
  };
}

/** A Claude reading whose only model-scoped window is the Fable weekly one. */
function fableQuota(): ProviderQuota {
  return {
    provider: "claude",
    label: "Claude",
    source: "oauth",
    windows: [
      {
        id: "model:fable",
        label: "Fable week",
        kind: "model",
        percentUsed: 20,
        percentRemaining: 80,
        modelScope: { id: "model:fable", name: "Fable", period: "weekly" },
      },
    ],
    state: { status: "fresh", stale: false, sourcesTried: ["oauth"] },
  };
}

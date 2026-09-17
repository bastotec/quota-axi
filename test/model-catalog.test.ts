import { describe, expect, it } from "vitest";

import {
  intelligenceForLiveModel,
  liveModelMatchesWindowSlug,
  modelWindowSlug,
} from "../src/model-catalog.js";
import type { ModelCatalogEntry } from "../src/types.js";

describe("modelWindowSlug", () => {
  it("returns the vendor slug for model scopes only", () => {
    expect(modelWindowSlug("model:fable")).toBe("fable");
    expect(modelWindowSlug("model:gpt-5.1-codex")).toBe("gpt-5.1-codex");
    expect(modelWindowSlug("all_models")).toBe("");
  });
});

describe("liveModelMatchesWindowSlug", () => {
  it("keeps a family scope on that family and off every other model", () => {
    const fable = { id: "claude-fable-5-1", label: "Claude Fable 5.1" };
    const opus = { id: "claude-opus-4-5-20251101", label: "Claude Opus 4.5" };

    expect(liveModelMatchesWindowSlug(fable, "fable")).toBe(true);
    expect(liveModelMatchesWindowSlug(opus, "fable")).toBe(false);
  });

  it("matches a scope that names one model exactly", () => {
    const codex = { id: "gpt-5.1-codex", label: "GPT-5.1-Codex" };
    expect(liveModelMatchesWindowSlug(codex, "gpt-5.1-codex")).toBe(true);
    expect(liveModelMatchesWindowSlug(codex, "gpt-5-codex-mini")).toBe(false);
  });

  it("keeps a versioned scope off a different version of the same family", () => {
    const opus45 = { id: "claude-opus-4-5-20251101", label: "Claude Opus 4.5" };

    expect(liveModelMatchesWindowSlug(opus45, "claude_opus_4")).toBe(false);
    expect(liveModelMatchesWindowSlug(opus45, "claude-opus-4")).toBe(false);
    expect(liveModelMatchesWindowSlug(opus45, "claude_opus_4_5")).toBe(true);
  });

  it("matches a versioned scope on the vendor's dated snapshot of that model", () => {
    const opus4 = { id: "claude-opus-4-20250514", label: "Claude Opus 4" };

    expect(liveModelMatchesWindowSlug(opus4, "claude-opus-4")).toBe(true);
  });

  it("matches whole tokens, never a substring of a longer word", () => {
    const sonnet = { id: "claude-sonnet-5", label: "Claude Sonnet 5" };
    // "son" is inside "sonnet" but is not a token of it.
    expect(liveModelMatchesWindowSlug(sonnet, "son")).toBe(false);
  });

  it("never matches on an empty scope", () => {
    const model = { id: "claude-opus-5", label: "Claude Opus 5" };
    expect(liveModelMatchesWindowSlug(model, "")).toBe(false);
  });
});

describe("intelligenceForLiveModel", () => {
  const entries: ModelCatalogEntry[] = [
    {
      provider: "claude",
      id: "claude-sonnet-4-5",
      label: "Claude Sonnet 4.5",
      intelligence: "high",
    },
    {
      provider: "grok",
      id: "grok-4",
      label: "Grok 4",
      intelligence: "high",
      aliases: ["grok-4-latest"],
    },
  ];

  it("covers the same model shipped under a dated vendor id", () => {
    expect(
      intelligenceForLiveModel(
        { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
        entries,
      ),
    ).toBe("high");
  });

  it("matches a declared alias", () => {
    expect(
      intelligenceForLiveModel(
        { id: "grok-4-latest", label: "Grok 4" },
        entries,
      ),
    ).toBe("high");
  });

  it("leaves an unreviewed model unknown instead of inheriting a bucket", () => {
    expect(
      intelligenceForLiveModel(
        { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
        entries,
      ),
    ).toBeUndefined();
  });

  it("does not treat a longer sibling id as a dated snapshot", () => {
    expect(
      intelligenceForLiveModel(
        { id: "claude-sonnet-4-5-turbo", label: "Claude Sonnet 4.5 Turbo" },
        entries,
      ),
    ).toBeUndefined();
  });
});

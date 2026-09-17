import { describe, expect, it } from "vitest";

import {
  intelligenceForLiveModel,
  liveModelMatchesScope,
} from "../src/model-catalog.js";
import type { ModelCatalogEntry, ModelWindowScope } from "../src/types.js";

/** A scope the vendor named without giving a model id. */
function namedScope(name: string): ModelWindowScope {
  return { id: `model:${name}`, name };
}

describe("liveModelMatchesScope", () => {
  it("keeps a family scope on that family and off every other model", () => {
    const fable = { id: "claude-fable-5-1", label: "Claude Fable 5.1" };
    const opus = { id: "claude-opus-4-5-20251101", label: "Claude Opus 4.5" };

    expect(liveModelMatchesScope(fable, namedScope("Fable"))).toBe(true);
    expect(liveModelMatchesScope(opus, namedScope("Fable"))).toBe(false);
  });

  it("reaches a family scope the vendor spelled into a fixed window id", () => {
    // Anthropic's `seven_day_opus` field: the scope word is the vendor's, and
    // the window id is not `model:`-prefixed at all.
    const opusScope: ModelWindowScope = {
      id: "seven_day_opus",
      name: "Opus",
    };

    expect(
      liveModelMatchesScope(
        { id: "claude-opus-4-5-20251101", label: "Claude Opus 4.5" },
        opusScope,
      ),
    ).toBe(true);
    expect(
      liveModelMatchesScope(
        { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
        opusScope,
      ),
    ).toBe(false);
  });

  it("matches a scope that names one model exactly", () => {
    const codex = { id: "gpt-5.1-codex", label: "GPT-5.1-Codex" };
    expect(liveModelMatchesScope(codex, namedScope("gpt-5.1-codex"))).toBe(
      true,
    );
    expect(liveModelMatchesScope(codex, namedScope("gpt-5-codex-mini"))).toBe(
      false,
    );
  });

  it("keeps a versioned scope off a different version of the same family", () => {
    const opus45 = { id: "claude-opus-4-5-20251101", label: "Claude Opus 4.5" };

    expect(liveModelMatchesScope(opus45, namedScope("claude_opus_4"))).toBe(
      false,
    );
    expect(liveModelMatchesScope(opus45, namedScope("claude-opus-4"))).toBe(
      false,
    );
    expect(liveModelMatchesScope(opus45, namedScope("claude_opus_4_5"))).toBe(
      true,
    );
  });

  it("matches a versioned scope on the vendor's dated snapshot of that model", () => {
    const opus4 = { id: "claude-opus-4-20250514", label: "Claude Opus 4" };

    expect(liveModelMatchesScope(opus4, namedScope("claude-opus-4"))).toBe(
      true,
    );
  });

  it("matches a vendor model id exactly and never as a family", () => {
    const opus45 = { id: "claude-opus-4-5-20251101", label: "Claude Opus 4.5" };

    expect(
      liveModelMatchesScope(opus45, {
        id: "model:claude-opus-4-5",
        modelId: "claude-opus-4-5",
        name: "Claude Opus 4.5",
      }),
    ).toBe(true);
    // The id the vendor gave decides alone: a family-shaped display name
    // alongside it never widens the scope back out.
    expect(
      liveModelMatchesScope(
        { id: "claude-opus-4-1", label: "Claude Opus 4.1" },
        {
          id: "model:claude-opus-4-5",
          modelId: "claude-opus-4-5",
          name: "Opus",
        },
      ),
    ).toBe(false);
  });

  it("matches whole tokens, never a substring of a longer word", () => {
    const sonnet = { id: "claude-sonnet-5", label: "Claude Sonnet 5" };
    // "son" is inside "sonnet" but is not a token of it.
    expect(liveModelMatchesScope(sonnet, namedScope("son"))).toBe(false);
  });

  it("never matches a scope carrying no vendor words at all", () => {
    const model = { id: "claude-opus-5", label: "Claude Opus 5" };
    expect(liveModelMatchesScope(model, { id: "model:unknown" })).toBe(false);
    expect(liveModelMatchesScope(model, namedScope(""))).toBe(false);
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

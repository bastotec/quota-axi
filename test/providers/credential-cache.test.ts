import { describe, expect, it, vi } from "vitest";

import { createProviderCredentialCache } from "../../src/providers/credential-cache.js";

describe("provider credential cache", () => {
  it("resolves a key once and reuses that resolution", async () => {
    const cache = createProviderCredentialCache();
    const resolve = vi.fn(async () => ["keychain"]);

    expect(await cache.read("claude", resolve)).toEqual(["keychain"]);
    expect(await cache.read("claude", resolve)).toEqual(["keychain"]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight resolution with concurrent readers", async () => {
    const cache = createProviderCredentialCache();
    const resolve = vi.fn(async () => "token");

    const [first, second] = await Promise.all([
      cache.read("claude", resolve),
      cache.read("claude", resolve),
    ]);

    expect([first, second]).toEqual(["token", "token"]);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("keeps separate keys apart", async () => {
    const cache = createProviderCredentialCache();

    expect(await cache.read("claude", async () => "a")).toBe("a");
    expect(await cache.read("codex", async () => "b")).toBe("b");
  });

  it("resolves again after the store it read was rewritten", async () => {
    const cache = createProviderCredentialCache();
    const resolve = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("before")
      .mockResolvedValueOnce("after");

    expect(await cache.read("claude", resolve)).toBe("before");
    cache.invalidate("claude");
    expect(await cache.read("claude", resolve)).toBe("after");
  });

  it("does not replay a failed resolution for the rest of the run", async () => {
    const cache = createProviderCredentialCache();
    const resolve = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("store unreadable"))
      .mockResolvedValueOnce("token");

    await expect(cache.read("claude", resolve)).rejects.toThrow(
      "store unreadable",
    );
    expect(await cache.read("claude", resolve)).toBe("token");
  });
});

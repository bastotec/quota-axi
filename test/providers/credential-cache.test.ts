import { describe, expect, it } from "vitest";

import {
  createProviderCredentialCache,
  credentialDiscriminator,
} from "../../src/providers/credential-cache.js";

describe("provider credential cache: the shared store resolution", () => {
  it("resolves once per key and re-resolves after invalidation", async () => {
    let reads = 0;
    const cache = createProviderCredentialCache();
    const read = () =>
      cache.read("claude:store", async () => {
        reads++;
        return `token-${reads}`;
      });

    expect(await read()).toBe("token-1");
    expect(await read()).toBe("token-1");
    cache.invalidate("claude:store");
    expect(await read()).toBe("token-2");
    expect(reads).toBe(2);
  });

  it("keeps a failed resolution out of the cache", async () => {
    let attempts = 0;
    const cache = createProviderCredentialCache();
    const read = () =>
      cache.read("claude:store", async () => {
        attempts++;
        if (attempts === 1) throw new Error("transient");
        return "token";
      });

    await expect(read()).rejects.toThrow("transient");
    expect(await read()).toBe("token");
  });

  it("keeps one store's resolution out of another's", async () => {
    const cache = createProviderCredentialCache();
    const read = (key: string, value: string) =>
      cache.read(key, async () => value);

    expect(await read("claude:profile-a", "token-a")).toBe("token-a");
    expect(await read("claude:profile-b", "token-b")).toBe("token-b");
    expect(await read("claude:profile-a", "unused")).toBe("token-a");
  });
});

describe("provider credential cache: the rejection latch", () => {
  it("latches only the credential that was rejected", () => {
    const cache = createProviderCredentialCache();
    const rejected = credentialDiscriminator("claude", "rejected-token");
    const sibling = credentialDiscriminator("claude", "sibling-token");

    expect(cache.isCredentialRejected(rejected)).toBe(false);
    cache.rejectCredential(rejected);

    expect(cache.isCredentialRejected(rejected)).toBe(true);
    expect(cache.isCredentialRejected(sibling)).toBe(false);
  });

  /**
   * The distinction this module exists for. Invalidating says the store may
   * have been rewritten; it says nothing about the credential that resolution
   * held. A cache that answered a rejection by invalidating alone would resolve
   * an unchanged store to the same credential and hand it back to the endpoint
   * that just rejected it.
   */
  it("does not forget a rejection when the store resolution is invalidated", async () => {
    const cache = createProviderCredentialCache();
    const read = () => cache.read("claude:store", async () => "same-token");

    expect(await read()).toBe("same-token");
    cache.rejectCredential(credentialDiscriminator("claude", await read()));
    cache.invalidate("claude:store");

    // The store is unchanged, so it resolves the same credential again - and
    // that credential is still closed.
    expect(await read()).toBe("same-token");
    expect(
      cache.isCredentialRejected(
        credentialDiscriminator("claude", "same-token"),
      ),
    ).toBe(true);
  });

  it("gives each run its own latch", () => {
    const rejected = credentialDiscriminator("claude", "rejected-token");
    const first = createProviderCredentialCache();
    first.rejectCredential(rejected);

    expect(createProviderCredentialCache().isCredentialRejected(rejected)).toBe(
      false,
    );
  });
});

describe("credentialDiscriminator", () => {
  it("identifies the credential rather than the store that held it", () => {
    // Two stores can hold the same token, so rejecting one must withhold both.
    expect(credentialDiscriminator("claude", "token")).toBe(
      credentialDiscriminator("claude", "token"),
    );
    // A rotated store holds a different token under the same name, so the
    // replacement must not inherit the old credential's verdict.
    expect(credentialDiscriminator("claude", "token")).not.toBe(
      credentialDiscriminator("claude", "rotated"),
    );
  });

  it("keeps one provider's verdict out of another's", () => {
    expect(credentialDiscriminator("claude", "token")).not.toBe(
      credentialDiscriminator("codex", "token"),
    );
  });

  it("carries no credential material", () => {
    const secret = "sk-fixture-not-a-real-token";

    expect(credentialDiscriminator("claude", secret)).not.toContain(secret);
    expect(credentialDiscriminator("claude", secret)).toMatch(
      /^claude:[0-9a-f]{64}$/,
    );
  });
});

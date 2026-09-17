import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { cacheFilePath } from "../../src/lib/fs.js";
import { createProviderCredentialCache } from "../../src/providers/credential-cache.js";

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempDir: string | undefined;

afterEach(() => {
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("provider credential cache", () => {
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

  /**
   * The cache holds resolved credential material, so it must live only as long
   * as the invocation that created it: nothing it holds reaches disk, and a
   * later invocation resolves the store again rather than inheriting a
   * resolution taken under credentials, a profile, or an account that may since
   * have changed.
   */
  it("holds nothing on disk and shares nothing with another invocation", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-credential-cache-"));
    process.env.XDG_CACHE_HOME = tempDir;

    const invocation = createProviderCredentialCache();
    expect(await invocation.read("claude:store", async () => "secret")).toBe(
      "secret",
    );

    expect(existsSync(dirname(cacheFilePath()))).toBe(false);

    let resolvedAgain = false;
    const nextInvocation = createProviderCredentialCache();
    const value = await nextInvocation.read("claude:store", async () => {
      resolvedAgain = true;
      return "rotated";
    });

    expect(resolvedAgain).toBe(true);
    expect(value).toBe("rotated");
  });
});

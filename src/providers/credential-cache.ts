import type { ProviderCredentialCache } from "../types.js";

/**
 * A per-invocation cache for one provider's resolved credential state.
 *
 * A single command can read the same provider's store more than once: `models`
 * reads quota and then the vendor's own model lineup. Resolving the credential
 * again for the second read cost two things. On macOS the Keychain value read
 * happens twice, so a user who answers the plain "Allow" button is prompted
 * again inside the one command. And the two reads are independent, so a store
 * that changes between them lets one account's lineup be published beside
 * another account's windows.
 *
 * A cache belongs to one `ProviderOptions`, and therefore to one command
 * invocation: it holds only what that run already had in memory, is never
 * written anywhere, and is dropped when the run ends. A provider invalidates
 * its entry when the store behind it may have been rewritten - by a rotation it
 * delegated, or externally after a definitive rejection - so the next read
 * resolves the store again rather than reusing a stale resolution. Invalidation
 * says nothing about the credential itself: an unchanged store resolves the
 * same one again.
 */
export function createProviderCredentialCache(): ProviderCredentialCache {
  const entries = new Map<string, Promise<unknown>>();
  return {
    read<T>(key: string, resolve: () => Promise<T>): Promise<T> {
      const existing = entries.get(key);
      if (existing) return existing as Promise<T>;
      // A failed resolution is not kept: the next read starts over rather than
      // replaying one run's transient failure for the rest of the command.
      const pending: Promise<T> = resolve().catch((error: unknown) => {
        if (entries.get(key) === pending) entries.delete(key);
        throw error;
      });
      entries.set(key, pending);
      return pending;
    },
    invalidate(key: string): void {
      entries.delete(key);
    },
  };
}

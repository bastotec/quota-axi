import { createHash } from "node:crypto";

import type { ProviderCredentialCache } from "../types.js";

/**
 * Per-invocation credential state for one command: one shared resolution of
 * each store, plus a latch for the credentials this run has already watched a
 * provider definitively reject.
 *
 * A single command can read the same provider's store more than once: `models`
 * reads quota and then the vendor's own model lineup. Resolving the store again
 * for the second read costs two things. On macOS the Keychain value read
 * happens twice, so a user who answers the plain "Allow" button is prompted
 * again inside the one command. And the two reads are independent, so a store
 * that changes between them lets one account's lineup be published beside
 * another account's windows.
 *
 * The two halves answer different questions, and conflating them is the trap
 * this module exists to avoid:
 *
 * - {@link ProviderCredentialCache.read} / {@link
 *   ProviderCredentialCache.invalidate} are about *the store*. Invalidating
 *   says "what is on disk may no longer be what this run resolved", so the next
 *   read resolves it again. It says nothing whatsoever about the credential
 *   that came back: an unchanged store resolves the same credential, and a
 *   caller that only invalidated would hand that credential straight back to
 *   the endpoint that just rejected it - on macOS at the cost of a second
 *   Keychain value read and a second prompt.
 * - {@link ProviderCredentialCache.rejectCredential} / {@link
 *   ProviderCredentialCache.isCredentialRejected} are about *the credential*.
 *   A credential a provider definitively rejected is withheld from every later
 *   read in the same run, whether it is reached through a reused resolution or
 *   a freshly re-read store.
 *
 * Only a definitive rejection may latch, and what counts as definitive stays
 * the provider's own established rule - for Claude, HTTP 401 alone, because a
 * WAF 403 comes back for perfectly valid bearers. A transient failure must
 * never latch a credential closed: the next read would then withhold a
 * credential nothing has disproven.
 *
 * Everything here belongs to one `ProviderOptions`, and therefore to one
 * command invocation: it holds only what that run already had in memory, is
 * never written anywhere, and is dropped when the run ends. Credential values
 * are never stored - the latch keys on a non-secret discriminator (see {@link
 * credentialDiscriminator}), which is never logged, rendered, or persisted
 * either.
 */
export function createProviderCredentialCache(): ProviderCredentialCache {
  const entries = new Map<string, Promise<unknown>>();
  const rejected = new Set<string>();
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
    rejectCredential(credentialId: string): void {
      rejected.add(credentialId);
    },
    isCredentialRejected(credentialId: string): boolean {
      return rejected.has(credentialId);
    },
  };
}

/**
 * A stable, non-secret discriminator for one credential value.
 *
 * The latch has to tell credentials apart without holding one: two stores can
 * hold the same token (so rejecting one must withhold both), and a store the
 * vendor CLI rewrote holds a different token under the same name (so the
 * rotated credential must not inherit the old one's verdict). A digest answers
 * both without the latch ever carrying credential material.
 *
 * `scope` keeps one provider's latch from ever reading another's, so an
 * identical value in two providers' stores is two separate verdicts.
 */
export function credentialDiscriminator(scope: string, secret: string): string {
  return `${scope}:${createHash("sha256").update(secret).digest("hex")}`;
}

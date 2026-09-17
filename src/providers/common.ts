import type {
  ProviderQuota,
  ProviderSource,
  ProviderStateReason,
  ProviderStatus,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { percentRemaining } from "../lib/time.js";

export function withRemaining(
  window: Omit<QuotaWindow, "percentRemaining">,
): QuotaWindow {
  return {
    ...window,
    percentRemaining: percentRemaining(window.percentUsed),
  };
}

export function successProvider(
  provider: Omit<ProviderQuota, "state"> & {
    refreshedAt: string;
    sourcesTried: string[];
  },
): ProviderQuota {
  const { refreshedAt, sourcesTried, ...rest } = provider;
  return {
    ...rest,
    state: {
      status: "fresh",
      stale: false,
      refreshedAt,
      sourcesTried,
    },
  };
}

export function failedProvider(args: {
  provider: ProviderQuota["provider"];
  label: string;
  status: ProviderStatus;
  error: string;
  sourcesTried: string[];
  source?: ProviderSource;
  retryAfter?: string;
  reason?: ProviderStateReason;
  attempts?: SourceAttempt[];
}): ProviderQuota {
  return {
    provider: args.provider,
    label: args.label,
    source: args.source ?? "unavailable",
    windows: [],
    state: {
      status: args.status,
      stale: false,
      error: args.error,
      retryAfter: args.retryAfter,
      ...(args.reason ? { reason: args.reason } : {}),
      sourcesTried: args.sourcesTried,
    },
    attempts: args.attempts,
  };
}

/**
 * What the run established about a local credential, weakest evidence first.
 *
 * `none`: no store quota-axi reads held anything for this provider at all.
 * `unusable`: a store was read and yielded nothing this adapter can send - a
 * malformed `auth.json`, a file holding no login, a key that fails the secret
 * guard - so no endpoint saw a credential.
 * `tested`: a credential was sent to a first-party endpoint, which answered.
 */
export type LocalCredentialEvidence = "none" | "unusable" | "tested";

const EVIDENCE_RANK: Record<LocalCredentialEvidence, number> = {
  none: 0,
  unusable: 1,
  tested: 2,
};

/** Evidence only ever strengthens across the sources one run reads. */
export function strongerEvidence(
  current: LocalCredentialEvidence,
  next: LocalCredentialEvidence,
): LocalCredentialEvidence {
  return EVIDENCE_RANK[next] > EVIDENCE_RANK[current] ? next : current;
}

/**
 * The one spelling of "what quota-axi actually learned about a credential".
 *
 * `auth_required` is a statement about where quota-axi looked, not about
 * whether the provider has a source: reporting it as a sign-out asserts
 * something about the account that no evidence in the run supports. Only a
 * credential a first-party endpoint refused earns that claim, so it alone
 * carries no reason; an adapter that came up empty-handed passes `none`, and
 * one that found a credential it could not send passes `unusable`. The typed
 * reason - never a reworded error string - carries the distinction to the
 * report, because the three lead to three different actions: look elsewhere,
 * fix the stored credential, or sign in again.
 */
export function localCredentialReason(
  status: ProviderStatus,
  evidence: LocalCredentialEvidence,
): ProviderStateReason | undefined {
  if (status !== "auth_required") return undefined;
  if (evidence === "none") return "no_local_credential";
  if (evidence === "unusable") return "local_credential_unusable";
  return undefined;
}

export function staleFromCache(
  cached: ProviderQuota,
  error: string,
  sourcesTried: string[],
  attempts: SourceAttempt[],
): ProviderQuota {
  return {
    ...cached,
    source: "cache",
    state: {
      ...cached.state,
      status: "stale",
      stale: true,
      error,
      sourcesTried: [...new Set([...sourcesTried, "cache"])],
    },
    attempts,
  };
}

export function statusFromError(error: string): ProviderStatus {
  if (
    error === "keychain_prompt_required" ||
    error === "credentials_expired" ||
    /sign-in|required|reauth|access token expired/i.test(error)
  )
    return "auth_required";
  if (/rate.?limit/i.test(error)) return "rate_limited";
  return "error";
}

/**
 * Attempt order, deduplicated: a source can be attempted twice in one run (a
 * credential store re-read after a delegated refresh), and `sourcesTried`
 * names which sources were tried, not how many times.
 */
export function sourceNames(attempts: SourceAttempt[]): string[] {
  return [...new Set(attempts.map((attempt) => attempt.source))];
}

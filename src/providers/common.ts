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
 * The one spelling of "quota-axi never obtained a credential to test".
 *
 * `auth_required` is a statement about where quota-axi looked, not about
 * whether the provider has a source: reporting it as a sign-out asserts
 * something about the account that no evidence in the run supports. Only a
 * credential a first-party endpoint refused earns that claim, so an adapter
 * passes `credentialTested: false` whenever every source it reads came up
 * empty, and the typed reason - never a reworded error string - carries the
 * distinction to the report.
 */
export function noLocalCredentialReason(
  status: ProviderStatus,
  credentialTested: boolean,
): ProviderStateReason | undefined {
  return status === "auth_required" && !credentialTested
    ? "no_local_credential"
    : undefined;
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

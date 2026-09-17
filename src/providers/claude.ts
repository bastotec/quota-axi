import { chmodSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { deleteCachedProvider, readCachedClaudeProvider } from "../cache.js";
import {
  claudeCredentialContextId,
  claudeKeychainAccessMarkerPath,
  ensurePrivateParent,
  readJsonFileResult,
  type JsonFileReadResult,
} from "../lib/fs.js";
import { providerFetch } from "../lib/http.js";
import { execFileText } from "../lib/process.js";
import { listRunningCommandLines } from "../lib/running-processes.js";
import { clampPercent, nowIso, retryAfterToIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  LiveModelCatalog,
  LiveModelRecord,
  ModelWindowScope,
  ProviderAdapter,
  ProviderCredentialCache,
  ProviderOptions,
  ProviderQuota,
  ProviderStatus,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import {
  failedProvider,
  sourceNames,
  statusFromError,
  successProvider,
  withRemaining,
} from "./common.js";
import { credentialDiscriminator } from "./credential-cache.js";
import {
  refreshDelegateAttempt,
  runRefreshDelegate,
  REFRESH_LIVE_VENDOR_PROCESS,
  REFRESH_VENDOR_UNKNOWN,
  type RefreshDelegate,
} from "./delegated-refresh.js";
import { withUsageFetchFailure } from "./usage-fetch-failure.js";

const API_URL = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_API_URL = "https://api.anthropic.com/api/oauth/profile";
/**
 * Anthropic's own model listing. It is a read-only GET that enumerates the
 * models this account may use: it starts no session, sends no model request,
 * and spends none of the quota being measured, so it is safe on the same
 * never-spend footing as the usage probe.
 */
const MODELS_API_URL = "https://api.anthropic.com/v1/models?limit=100";
const MODELS_API_VERSION = "2023-06-01";
const OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_CODE_USER_AGENT = "claude-code/2.1.202";
const API_TIMEOUT_MS = 15_000;
const KEYCHAIN_PROMPT_TIMEOUT_MS = 60_000;
const KEYCHAIN_PRESENCE_TIMEOUT_MS = 5_000;
/** `security` exit 44 is cannot-reach (locked, TCC, daemon), not item-absent. */
const KEYCHAIN_ITEM_UNREACHABLE_EXIT_CODE = 44;
const KEYCHAIN_UNREACHABLE_ERROR = "keychain_unreachable";
/**
 * Anthropic's own verdict on a bearer it rejected with HTTP 401. A read that
 * withholds an already-rejected credential reports this same verdict, because
 * it is what presenting that credential a second time would have produced.
 */
const CLAUDE_SIGN_IN_REQUIRED = "Claude sign-in required";
/**
 * A stored credential that was not sent because this run already watched
 * Anthropic definitively reject it. Recorded on the attempt so `--full` shows
 * why no request was made, rather than the read looking like it never had a
 * credential at all.
 */
const CREDENTIAL_REJECTED_THIS_RUN = "credential_rejected_this_run";
const DEFAULT_KEYCHAIN_SERVICE = "Claude Code-credentials";
const DEFAULT_KEYCHAIN_ACCOUNT = "claude-code-user";
const SAFE_KEYCHAIN_ACCOUNT = /^[a-zA-Z0-9._-]+$/;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;
const FIVE_HOURS_SECONDS = 18_000;
const SEVEN_DAYS_SECONDS = 604_800;

/**
 * The scope of Anthropic's fixed `seven_day_opus` field.
 *
 * Anthropic names the field after the model family it meters, and `Opus` is
 * Anthropic's word for that family on both sides of the join: this scope
 * reaches a live model only when Anthropic's own lineup spells `opus` in that
 * model's identity. It is not a claim that the window id means any particular
 * model id - the vendor's lineup decides which models the family contains, and
 * when no live lineup is available nothing is attributed at all.
 *
 * This is why the field exists: the window id is `seven_day_opus`, so a reader
 * that recovered scope from the id could not reach this window at all, and the
 * Opus rows silently inherited the account-wide remaining instead of the Opus
 * bound that actually governs them.
 */
const OPUS_WEEK_SCOPE: ModelWindowScope = {
  id: "seven_day_opus",
  name: "Opus",
};

type ClaudeCredentials = {
  source: "oauth-file" | "keychain";
  accessToken: string;
  plan?: string;
  expiresAt?: number;
};

type AvailableCredentialState = {
  status: "available";
  credentials: ClaudeCredentials;
};
type AdvisoryExpiredCredentialState = {
  status: "expired";
  credentials: ClaudeCredentials;
  source: AuthSourceReport;
  /**
   * Whether the same store holds a refresh token beside the expired access
   * token. Presence only: quota-axi never reads that value, and the Claude CLI
   * is the only thing that ever exchanges it.
   */
  refreshable: boolean;
};
type UnavailableCredentialState = {
  status: "missing" | "invalid";
  source: AuthSourceReport;
};
type SkippedCredentialState = { status: "skipped"; source: AuthSourceReport };
type CredentialState =
  | AvailableCredentialState
  | AdvisoryExpiredCredentialState
  | UnavailableCredentialState
  | SkippedCredentialState;
/** A resolved credential a read may actually present to Anthropic. */
type ClaudeCredentialCandidate =
  | AvailableCredentialState
  | AdvisoryExpiredCredentialState;
type KeychainItemPresence = "present" | "missing" | "unknown";
type ClaudeAccount = NonNullable<ProviderQuota["account"]>;
type ClaudeIdentityResult = {
  account: ClaudeAccount;
  error?: string;
};
type ClaudeProfileLocations = {
  credentialFile: string;
  keychainAccount: string;
  keychainService: string;
  keychainAccessMarker: string;
};

type RawUsageWindow = {
  utilization?: unknown;
  resets_at?: unknown;
  reset_at?: unknown;
};

type ExtraUsageWindow = RawUsageWindow & {
  is_enabled?: unknown;
  monthly_limit?: unknown;
  used_credits?: unknown;
  decimal_places?: unknown;
};

type ClaudeFailureOptions = {
  status?: ProviderStatus;
  definitiveAuth?: boolean;
  staleEligible?: boolean;
  retryAfter?: string;
};

// A scoped-limit entry as returned in the `limits` array of the OAuth usage
// response. Unlike the fixed top-level fields (five_hour, seven_day, ...),
// this array self-describes every limit the account currently has, including
// ones scoped to a specific model (scope.model.display_name).
type ScopedLimitEntry = {
  kind?: unknown;
  group?: unknown;
  percent?: unknown;
  resets_at?: unknown;
  scope?: unknown;
};

export const claudeAdapter: ProviderAdapter = {
  id: "claude",
  label: "Claude",
  fetchQuota,
  inspectAuth,
  fetchModelCatalog,
};

/**
 * `claude doctor` is the smallest observed non-interactive Claude Code command
 * that makes the CLI renew its own expired OAuth session and rewrite whichever
 * store it owns (the macOS Keychain item, or `.credentials.json`). It prints an
 * installation health summary and exits: it starts no session, sends no model
 * request, spends no quota, opens no browser, and - unlike `claude mcp list` -
 * does not connect to configured MCP servers.
 *
 * Observed behavior that supports delegating to it: with the access token
 * expired it performs the refresh exchange, and a network failure during that
 * exchange leaves the stored session untouched. Only Anthropic definitively
 * rejecting the refresh token clears the session, which is Claude Code's own
 * handling of a session that has genuinely ended.
 *
 * That last property is exactly why the budget is generous and never enforced
 * with a signal: the run being delegated is a single-use refresh-token
 * exchange, so the dangerous outcome is not a slow `claude doctor` but a
 * half-finished one. quota-axi waits, then walks away (see
 * {@link runRefreshDelegate}).
 */
const CLAUDE_CLI_REFRESH_DELEGATE: RefreshDelegate = {
  source: "claude-cli-refresh",
  command: "claude",
  args: ["doctor"],
  waitBudgetMs: 45_000,
};

type ClaudeQuotaPass =
  | { kind: "success"; report: ProviderQuota }
  | {
      kind: "failure";
      failure: ClaudeFailure;
      /** The same expired, refreshable credential was definitively rejected. */
      refreshableExpiredRejected: boolean;
      /** A Keychain value read was withheld, so its store cannot be re-read. */
      keychainWithheld: boolean;
    };

export async function fetchQuota(
  options: ProviderOptions,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  const credentialContextId = claudeCredentialContextId();

  let pass = await attemptClaudeQuota(options, attempts);
  if (pass.kind === "success") return pass.report;

  // Soft expiry the Claude CLI can fix: hand the rotation to the CLI that owns
  // the credential store, then read back the session it rewrote.
  if (shouldDelegateClaudeRefresh(options, pass)) {
    const blocker = await liveClaudeRefreshBlocker();
    if (blocker) {
      attempts.push({
        source: CLAUDE_CLI_REFRESH_DELEGATE.source,
        status: "skipped",
        error: blocker,
      });
    } else {
      const run = await runRefreshDelegate(CLAUDE_CLI_REFRESH_DELEGATE);
      attempts.push(refreshDelegateAttempt(CLAUDE_CLI_REFRESH_DELEGATE, run));
      // The CLI may have rewritten the store, so the resolution this run shares
      // is no longer necessarily what is on disk. This is the one thing
      // quota-axi knows rewrote it. It is not a verdict on the credential that
      // resolution held: if the CLI rotated nothing, the same token resolves
      // again and stays withheld by the rejection latch.
      options.credentialCache?.invalidate(
        credentialCacheKey(resolveClaudeProfileLocations()),
      );
      if (run.status === "ran") {
        const retry = await attemptClaudeQuota(options, attempts);
        if (retry.kind === "success") return retry.report;
        pass = retry;
      } else if (run.status === "unconfirmed") {
        pass = { ...pass, failure: unconfirmedRefreshFailure() };
      }
    }
  }

  return failureReport(pass.failure, attempts, credentialContextId);
}

/**
 * Delegate only on soft expiry of a store quota-axi can read back: a stored
 * session that still carries a refresh token was definitively rejected. A
 * transient failure, a missing or malformed store, and a withheld Keychain
 * value all stay read-only - the last one keeps its existing Keychain advice,
 * because the CLI would rewrite a store quota-axi still could not read.
 */
function shouldDelegateClaudeRefresh(
  options: ProviderOptions,
  pass: Extract<ClaudeQuotaPass, { kind: "failure" }>,
): boolean {
  return (
    options.refreshCredentials &&
    pass.refreshableExpiredRejected &&
    !pass.keychainWithheld
  );
}

/**
 * A best-effort concurrency check on top of
 * {@link shouldDelegateClaudeRefresh}: quota-axi proceeds past this check only
 * when its process snapshot shows no Claude Code process already running.
 *
 * Claude Code owns its own session and refreshes it on its own schedule, and
 * the refresh token behind that session is single-use. A second refresher
 * racing a live session is how one holder ends up presenting a spent token, so
 * when the snapshot contains a live Claude Code process, quota-axi's
 * `claude doctor` is at best redundant and at worst the thing that signs the
 * user out. A quota reader loses nothing by standing down: the process that
 * owns the store is already doing the work, and the next read picks up the
 * session it wrote.
 *
 * Not knowing is treated the same as knowing a session is live, so an
 * unlistable process table (Windows, no effective uid, no `ps`) stays read-only
 * rather than guessing. The check and spawn are not atomic: a Claude Code
 * session starting after the check or another concurrent quota-axi read can
 * still overlap the delegate. This narrows the common repeated five-minute
 * `--tui` versus live-session collision and, together with never signaling the
 * delegate, is strictly safer than force-killing without adding a failure mode
 * beyond the pre-existing vendor-owned race. The skipped reason is recorded so
 * `--full` shows why no refresh happened.
 */
async function liveClaudeRefreshBlocker(): Promise<string | undefined> {
  const processes = await listRunningCommandLines();
  if (processes.status === "unavailable") return REFRESH_VENDOR_UNKNOWN;
  return processes.processes.some(
    ({ pid, commandLine }) =>
      pid !== process.pid && isLiveClaudeCodeProcess(commandLine),
  )
    ? REFRESH_LIVE_VENDOR_PROCESS
    : undefined;
}

/**
 * Recognize a running Claude Code process other than quota-axi itself from its
 * command line. The PID check in the caller is essential because quota-axi's
 * own argv may contain a standalone `claude` provider argument.
 *
 * The installed
 * `claude` executable (native installer or a versioned shim) or the npm
 * package running under a Node runtime. Every whitespace-separated token is
 * checked rather than only the first, because a `ps` command line splits an
 * installation path that contains a space. Matching is deliberately generous -
 * over-matching only means quota-axi stays read-only, which is the safe side.
 */
function isLiveClaudeCodeProcess(commandLine: string): boolean {
  const tokens = commandLine.split(/\s+/);
  if (tokens.some((token) => token.split("/").pop() === "claude")) return true;
  return commandLine.includes("@anthropic-ai/claude-code/");
}

/**
 * The vendor outran the wait and was left running, so quota-axi does not know
 * what the credential store now holds. It refuses to turn that into a sign-out
 * verdict: the report is an unmeasured provider (stale cache when one applies),
 * and the cached snapshot is kept rather than retired.
 */
function unconfirmedRefreshFailure(): ClaudeFailure {
  return new ClaudeFailure("claude_refresh_unconfirmed", {
    status: "unavailable",
    staleEligible: true,
  });
}

/**
 * Every testable credential in the order Claude Code itself keeps them: the
 * Keychain owns the session on macOS, then the longest-lived stored token.
 * Both the quota read and the model-listing read select through this, so one
 * run can never join one account's windows to another account's lineup.
 */
function orderedCredentialCandidates(
  states: readonly CredentialState[],
): ClaudeCredentialCandidate[] {
  return states
    .filter(
      (state): state is ClaudeCredentialCandidate =>
        state.status === "available" || state.status === "expired",
    )
    .sort((a, b) => {
      if (process.platform === "darwin") {
        if (
          a.credentials.source === "keychain" &&
          b.credentials.source !== "keychain"
        )
          return -1;
        if (
          b.credentials.source === "keychain" &&
          a.credentials.source !== "keychain"
        )
          return 1;
      }
      return (b.credentials.expiresAt ?? 0) - (a.credentials.expiresAt ?? 0);
    });
}

async function attemptClaudeQuota(
  options: ProviderOptions,
  attempts: SourceAttempt[],
): Promise<ClaudeQuotaPass> {
  const credentialStates = await readCredentialStates(options);
  const { usable: credentialCandidates, rejected: rejectedCandidates } =
    partitionRejectedCandidates(
      orderedCredentialCandidates(credentialStates),
      options.credentialCache,
    );

  for (const state of credentialStates) {
    if (state.status === "available" || state.status === "expired") continue;
    if (state.status === "skipped") {
      const attempt: SourceAttempt = {
        source: state.source.source,
        status: "skipped",
        error: state.source.error,
      };
      if (state.source.credentialPresent) attempt.credentialPresent = true;
      attempts.push(attempt);
      continue;
    }
    attempts.push({
      source: state.source.source,
      status: "skipped",
      error: `credentials_${state.status}`,
      // A malformed store still holds a credential, so a sibling source that
      // answers supersedes it rather than replacing it silently.
      ...(state.status === "invalid" ? { credentialPresent: true } : {}),
    });
  }

  // A retry after the delegated refresh re-resolves the store. When the vendor
  // CLI did not actually rotate it, the token this pass would present is the
  // one Anthropic already rejected, so it is withheld and named instead of
  // sent a second time.
  for (const state of rejectedCandidates) {
    attempts.push({
      source: state.credentials.source,
      status: "skipped",
      error: CREDENTIAL_REJECTED_THIS_RUN,
      credentialPresent: true,
    });
  }

  let definitiveFailure: ClaudeFailure | undefined;
  let transientFailure: ClaudeFailure | undefined;
  let refreshableExpiredRejected = false;

  if (credentialCandidates.length > 0) {
    for (const state of credentialCandidates) {
      const credential = state.credentials;
      attempts.push({ source: credential.source, status: "failed" });
      try {
        const quota = await fetchOauthUsage(credential);
        attempts[attempts.length - 1] = {
          source: credential.source,
          status: "success",
        };
        attempts.push(
          quota.identityError
            ? {
                source: "oauth-profile",
                status: "failed",
                error: quota.identityError,
                // The identity lookup is not a credential source, so its
                // failure never marks a source as superseded; `account`
                // already reports the unverified identity.
                degraded: false,
              }
            : { source: "oauth-profile", status: "success" },
        );
        return {
          kind: "success",
          report: successProvider({
            provider: "claude",
            label: "Claude",
            source: "oauth",
            plan: quota.plan,
            account: quota.account,
            windows: quota.windows,
            refreshedAt: quota.refreshedAt,
            sourcesTried: sourceNames(attempts),
            attempts,
          }),
        };
      } catch (error) {
        const failure = claudeFailureFor(error);
        attempts[attempts.length - 1] = {
          source: credential.source,
          status: "failed",
          error: failure.code,
        };
        if (failure.definitiveAuth) {
          definitiveFailure ??= failure;
          // Anthropic rejected this bearer outright, so no later read in this
          // run presents it again - not the post-refresh retry, and not the
          // model-lineup read. The latch is on the credential, so a rotation
          // that replaces it is unaffected and a sibling store holding the
          // same token is covered.
          options.credentialCache?.rejectCredential(
            claudeCredentialId(credential),
          );
          if (state.status === "expired" && state.refreshable) {
            refreshableExpiredRejected = true;
          }
        } else {
          transientFailure = failure.withUsageFetchFailure();
          break;
        }
      }
    }
  } else if (rejectedCandidates.length > 0) {
    // Withheld, not absent. Every credential this profile offers was already
    // definitively rejected in this run, so the verdict is Anthropic's own -
    // the one a second round of identical 401s would have produced - and never
    // the `credentials_missing` a bare empty candidate list would imply.
    definitiveFailure = new ClaudeFailure(CLAUDE_SIGN_IN_REQUIRED, {
      status: "auth_required",
      definitiveAuth: true,
    });
  } else {
    const skipped = credentialStates.find(
      (state): state is SkippedCredentialState => state.status === "skipped",
    );
    if (skipped) {
      transientFailure = new ClaudeFailure(
        skipped.source.error ?? "Claude quota unavailable",
        { staleEligible: true },
      );
    } else {
      const invalid = credentialStates.some(
        (state) => state.status === "invalid",
      );
      definitiveFailure = new ClaudeFailure(
        invalid ? "credentials_invalid" : "credentials_missing",
        { status: "auth_required", definitiveAuth: true },
      );
    }
  }

  const keychainDenied = credentialStates.some(
    (state) =>
      state.status === "skipped" &&
      state.source.source === "keychain" &&
      state.source.error === "keychain_access_denied",
  );
  let failure =
    transientFailure ??
    definitiveFailure ??
    new ClaudeFailure("Claude quota unavailable", { staleEligible: true });
  // A denied Keychain read never saw the live session. A 401 from a leftover
  // oauth-file sidecar is not evidence the user is signed out of Claude.
  if (keychainDenied && failure.definitiveAuth) {
    failure = new ClaudeFailure("keychain_access_denied", {
      staleEligible: true,
    });
  }

  return {
    kind: "failure",
    failure,
    refreshableExpiredRejected,
    keychainWithheld: credentialStates.some(
      (state) =>
        state.status === "skipped" && state.source.source === "keychain",
    ),
  };
}

function failureReport(
  failure: ClaudeFailure,
  attempts: SourceAttempt[],
  credentialContextId: string,
): ProviderQuota {
  if (failure.definitiveAuth) {
    try {
      deleteCachedProvider("claude");
    } catch {
      // Current authentication remains definitive when cache I/O is blocked.
    }
  }

  if (failure.staleEligible) {
    try {
      const cached = readCachedClaudeProvider(credentialContextId);
      const stale = cached
        ? staleClaudeReport(cached, failure, attempts, Date.now())
        : undefined;
      if (stale) return stale;
    } catch {
      // Cache I/O cannot replace the current bounded provider failure.
    }
  }

  return failedProvider({
    provider: "claude",
    label: "Claude",
    status: failure.status,
    error: failure.code,
    retryAfter: failure.retryAfter,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

function staleClaudeReport(
  cached: ProviderQuota,
  failure: ClaudeFailure,
  attempts: SourceAttempt[],
  now: number,
): ProviderQuota | undefined {
  if (
    cached.provider !== "claude" ||
    cached.source !== "oauth" ||
    cached.state.status !== "fresh" ||
    !cached.state.refreshedAt
  ) {
    return undefined;
  }
  const refreshedAt = Date.parse(cached.state.refreshedAt);
  if (!Number.isFinite(refreshedAt) || refreshedAt > now) return undefined;
  const ageMilliseconds = now - refreshedAt;
  if (ageMilliseconds >= SEVEN_DAYS_MS) return undefined;

  const windows = cached.windows.filter((window) => {
    if (window.resetsAt !== undefined) {
      const resetsAt = Date.parse(window.resetsAt);
      return Number.isFinite(resetsAt) && resetsAt > now;
    }
    const maxAge = resetlessWindowMaxAge(window);
    return maxAge !== undefined && ageMilliseconds < maxAge;
  });
  if (windows.length === 0) return undefined;

  const report: ProviderQuota = {
    provider: "claude",
    label: "Claude",
    source: "cache",
    ...(cached.plan ? { plan: cached.plan } : {}),
    windows,
    state: {
      status: "stale",
      stale: true,
      refreshedAt: cached.state.refreshedAt,
      error: failure.code,
      ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}),
      sourcesTried: [...new Set([...sourceNames(attempts), "cache"])],
    },
    attempts,
  };
  return failure.usageFetchFailure ? withUsageFetchFailure(report) : report;
}

function resetlessWindowMaxAge(window: QuotaWindow): number | undefined {
  if (window.kind === "weekly" || window.kind === "model") {
    return SEVEN_DAYS_MS;
  }
  if (
    window.kind === "session" ||
    window.kind === "monthly" ||
    window.kind === "credits"
  ) {
    return FIVE_HOURS_MS;
  }
  return undefined;
}

function claudeFailureFor(error: unknown): ClaudeFailure {
  if (error instanceof ClaudeFailure) return error;
  return new ClaudeFailure(errorMessage(error), { staleEligible: true });
}

export async function inspectAuth(
  options: ProviderOptions,
): Promise<AuthProviderReport> {
  const locations = resolveClaudeProfileLocations();
  const states = await readCredentialStates(options, locations);
  const sources = states.map((state): AuthSourceReport => {
    if (state.status === "available") {
      return {
        source: state.credentials.source,
        path:
          state.credentials.source === "oauth-file"
            ? locations.credentialFile
            : undefined,
        status: "available",
      };
    }
    return state.source;
  });
  return { provider: "claude", sources };
}

export function normalizeClaudeApiUsage(
  raw: unknown,
  plan?: string,
): { plan?: string; windows: QuotaWindow[]; refreshedAt: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as Record<string, unknown>;

  // The `limits` array (when present) is the vendor's own authoritative list
  // of every window the account currently has, including ones scoped to a
  // specific model (e.g. Fable, Opus). Prefer it over the fixed top-level
  // fields so newly introduced scoped limits show up without code changes.
  const scopedWindows = normalizeScopedLimits(data.limits);
  const windows =
    scopedWindows.length > 0
      ? scopedWindows
      : [
          normalizeWindow(data.five_hour, "five_hour", "session", "session"),
          normalizeWindow(data.seven_day, "seven_day", "week", "weekly"),
          normalizeWindow(
            data.seven_day_opus,
            "seven_day_opus",
            "opus week",
            "model",
            OPUS_WEEK_SCOPE,
          ),
        ].filter((window): window is QuotaWindow => Boolean(window));

  const extraUsage = normalizeExtraUsage(data.extra_usage);
  if (extraUsage) windows.push(extraUsage);

  if (windows.length === 0) return undefined;
  return { plan, windows, refreshedAt: nowIso() };
}

export function normalizeClaudeProfile(
  raw: unknown,
): ClaudeAccount | undefined {
  const data = objectValue(raw);
  if (!data) return undefined;
  const account = objectValue(data.account);
  const accountId = stringValue(account?.uuid);
  if (!accountId) return undefined;

  const organization = objectValue(data.organization);
  return {
    accountId,
    email:
      stringValue(account?.email) ??
      stringValue(account?.email_address) ??
      stringValue(account?.emailAddress) ??
      stringValue(data.email_address) ??
      stringValue(data.emailAddress) ??
      stringValue(data.email),
    organization:
      stringValue(organization?.name) ??
      stringValue(data.organization_name) ??
      stringValue(data.organizationName),
    identityStatus: "verified",
  };
}

function normalizeScopedLimits(raw: unknown): QuotaWindow[] {
  if (!Array.isArray(raw)) return [];
  const windows: QuotaWindow[] = [];
  for (const entry of raw) {
    const window = normalizeScopedLimitEntry(entry);
    if (window) windows.push(window);
  }
  return windows;
}

function normalizeScopedLimitEntry(raw: unknown): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const entry = raw as ScopedLimitEntry;
  const percent = typeof entry.percent === "number" ? entry.percent : undefined;
  if (percent === undefined) return undefined;
  const resetsAt = stringValue(entry.resets_at);

  const scope = objectValue(entry.scope);
  const model = scope ? objectValue(scope.model) : undefined;
  const modelName = model ? stringValue(model.display_name) : undefined;
  if (modelName) {
    // Anthropic sends the scope already structured, so it is carried through
    // rather than flattened into the id for a later reader to take apart. The
    // id keeps its established spelling because it is this provider's window
    // identifier, not the thing attribution reads.
    const modelId = stringValue(model?.id);
    const id = `model:${modelId ?? slugify(modelName)}`;
    return withRemaining({
      id,
      label: `${modelName} week`,
      kind: "model",
      percentUsed: clampPercent(percent),
      resetsAt,
      windowSeconds: SEVEN_DAYS_SECONDS,
      modelScope: {
        id,
        ...(modelId ? { modelId } : {}),
        name: modelName,
      },
    });
  }

  const group = stringValue(entry.group);
  if (group === "session") {
    return withRemaining({
      id: "five_hour",
      label: "session",
      kind: "session",
      percentUsed: clampPercent(percent),
      resetsAt,
      windowSeconds: FIVE_HOURS_SECONDS,
    });
  }
  if (group === "weekly") {
    return withRemaining({
      id: "seven_day",
      label: "week",
      kind: "weekly",
      percentUsed: clampPercent(percent),
      resetsAt,
      windowSeconds: SEVEN_DAYS_SECONDS,
    });
  }

  const kind = stringValue(entry.kind);
  return withRemaining({
    id: kind ?? "limit",
    label: kind ?? "limit",
    kind: "unknown",
    percentUsed: clampPercent(percent),
    resetsAt,
  });
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Every credential this profile can offer, resolved once per command.
 *
 * Reading the store is the step that can prompt for the macOS Keychain value
 * and the step that decides which account answers, so a run that reads Claude
 * twice - `models` reads quota and then the vendor's lineup - resolves it once
 * and reuses that resolution. It is invalidated only when quota-axi itself
 * knows the store was rewritten, which is the delegated refresh; that is a
 * statement about the store, not about any credential it produced, so it is
 * never what keeps a rejected credential out of a later read. The rejection
 * latch does that, and it holds across both a reused resolution and a
 * re-resolved one.
 */
async function readCredentialStates(
  options: ProviderOptions,
  locations = resolveClaudeProfileLocations(),
): Promise<CredentialState[]> {
  const resolve = () => resolveCredentialStates(options, locations);
  return options.credentialCache
    ? options.credentialCache.read(credentialCacheKey(locations), resolve)
    : resolve();
}

function credentialCacheKey(locations: ClaudeProfileLocations): string {
  return `claude:${locations.credentialFile}:${locations.keychainService}`;
}

/**
 * This run's non-secret discriminator for a stored Claude credential. Claude's
 * two stores can hold the same token, and `claude doctor` replaces the token
 * behind an unchanged store path, so the latch keys on the credential rather
 * than on the source that carried it.
 */
function claudeCredentialId(credentials: ClaudeCredentials): string {
  return credentialDiscriminator("claude", credentials.accessToken);
}

/**
 * Split the ordered candidates into the ones a later read may still present
 * and the ones this run already watched Anthropic definitively reject.
 *
 * Withholding is not the same as having no credential: the caller reports the
 * rejection that produced the latch, never a missing or absent store.
 */
function partitionRejectedCandidates(
  candidates: readonly ClaudeCredentialCandidate[],
  cache: ProviderCredentialCache | undefined,
): {
  usable: ClaudeCredentialCandidate[];
  rejected: ClaudeCredentialCandidate[];
} {
  const usable: ClaudeCredentialCandidate[] = [];
  const rejected: ClaudeCredentialCandidate[] = [];
  for (const candidate of candidates) {
    if (cache?.isCredentialRejected(claudeCredentialId(candidate.credentials)))
      rejected.push(candidate);
    else usable.push(candidate);
  }
  return { usable, rejected };
}

async function resolveCredentialStates(
  options: ProviderOptions,
  locations: ClaudeProfileLocations,
): Promise<CredentialState[]> {
  const states: CredentialState[] = [];

  const fileState = extractCredentialState(
    readJsonFileResult(locations.credentialFile),
    "oauth-file",
    locations.credentialFile,
  );
  states.push(fileState);

  if (process.platform === "darwin") {
    if (options.allowKeychainPrompt || hasKeychainAccessMarker(locations)) {
      states.push(await readKeychainCredentialState(locations));
    } else {
      states.push(await readSkippedKeychainCredentialState(locations));
    }
  }

  return states;
}

async function readSkippedKeychainCredentialState(
  locations: ClaudeProfileLocations,
): Promise<CredentialState> {
  const presence = await readKeychainItemPresence(locations);
  if (presence === "present") {
    return {
      status: "skipped",
      source: {
        source: "keychain",
        status: "skipped",
        error: "keychain_prompt_required",
        credentialPresent: true,
      },
    };
  }
  if (presence === "missing") {
    return {
      status: "missing",
      source: { source: "keychain", status: "missing" },
    };
  }
  return {
    status: "skipped",
    source: {
      source: "keychain",
      status: "skipped",
      error: "keychain_presence_check_failed",
      credentialPresent: true,
    },
  };
}

async function readKeychainItemPresence(
  locations: ClaudeProfileLocations,
): Promise<KeychainItemPresence> {
  try {
    await execFileText(
      "security",
      [
        "find-generic-password",
        "-a",
        locations.keychainAccount,
        "-s",
        locations.keychainService,
      ],
      KEYCHAIN_PRESENCE_TIMEOUT_MS,
    );
    return "present";
  } catch {
    return "unknown";
  }
}

async function readKeychainCredentialState(
  locations: ClaudeProfileLocations,
): Promise<CredentialState> {
  let blob: string;
  try {
    blob = await execFileText(
      "security",
      [
        "find-generic-password",
        "-a",
        locations.keychainAccount,
        "-w",
        "-s",
        locations.keychainService,
      ],
      KEYCHAIN_PROMPT_TIMEOUT_MS,
    );
  } catch (error) {
    return keychainFailureState(error);
  }
  writeKeychainAccessMarkerBestEffort(locations);
  try {
    return extractCredentialState(
      { status: "success", value: JSON.parse(blob) },
      "keychain",
    );
  } catch {
    return {
      status: "invalid",
      source: {
        source: "keychain",
        status: "invalid",
        error: "json_parse_error",
      },
    };
  }
}

function hasKeychainAccessMarker(locations: ClaudeProfileLocations): boolean {
  return existsSync(locations.keychainAccessMarker);
}

function writeKeychainAccessMarkerBestEffort(
  locations: ClaudeProfileLocations,
): void {
  try {
    const file = locations.keychainAccessMarker;
    ensurePrivateParent(file);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, "granted\n", { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
    chmodSync(file, 0o600);
  } catch {
    return;
  }
}

export function claudeCredentialFile(): string {
  return resolveClaudeProfileLocations().credentialFile;
}

export function claudeKeychainService(): string {
  return resolveClaudeProfileLocations().keychainService;
}

export function claudeKeychainAccount(): string {
  let candidate = process.env.USER;
  if (!candidate) {
    try {
      candidate = userInfo().username;
    } catch {
      candidate = undefined;
    }
  }
  return candidate && SAFE_KEYCHAIN_ACCOUNT.test(candidate)
    ? candidate
    : DEFAULT_KEYCHAIN_ACCOUNT;
}

function resolveClaudeProfileLocations(): ClaudeProfileLocations {
  const configuredDir = process.env.CLAUDE_CONFIG_DIR;
  const configDir = (configuredDir ?? join(homedir(), ".claude")).normalize(
    "NFC",
  );
  const keychainConfigDir = configuredDir ? configDir : undefined;
  const keychainAccount = claudeKeychainAccount();
  return {
    credentialFile: join(configDir, ".credentials.json"),
    keychainAccount,
    keychainService: keychainServiceForConfigDir(keychainConfigDir),
    keychainAccessMarker: claudeKeychainAccessMarkerPath(
      keychainAccount,
      keychainConfigDir,
    ),
  };
}

function keychainServiceForConfigDir(configDir?: string): string {
  if (!configDir) return DEFAULT_KEYCHAIN_SERVICE;
  const suffix = createHash("sha256")
    .update(configDir)
    .digest("hex")
    .slice(0, 8);
  return `${DEFAULT_KEYCHAIN_SERVICE}-${suffix}`;
}

function isKeychainItemUnreachable(error: unknown): boolean {
  return (
    (error as { code?: number | string | null }).code ===
    KEYCHAIN_ITEM_UNREACHABLE_EXIT_CODE
  );
}

function keychainFailureState(error: unknown): CredentialState {
  const failure = error as {
    killed?: boolean;
    signal?: string | null;
    code?: number | string | null;
  };
  if (failure.killed || failure.signal) {
    return {
      status: "skipped",
      source: {
        source: "keychain",
        status: "skipped",
        error: "keychain_prompt_timeout",
        credentialPresent: true,
      },
    };
  }
  if (isKeychainItemUnreachable(error)) {
    return {
      status: "skipped",
      source: {
        source: "keychain",
        status: "skipped",
        error: KEYCHAIN_UNREACHABLE_ERROR,
        credentialPresent: true,
      },
    };
  }
  return {
    status: "skipped",
    source: {
      source: "keychain",
      status: "skipped",
      error: "keychain_access_denied",
      credentialPresent: true,
    },
  };
}

function extractCredentialState(
  raw: JsonFileReadResult,
  source: ClaudeCredentials["source"],
  path?: string,
): CredentialState {
  if (raw.status === "missing")
    return { status: "missing", source: { source, path, status: "missing" } };
  if (raw.status === "invalid")
    return {
      status: "invalid",
      source: { source, path, status: "invalid", error: raw.error },
    };
  const data = objectValue(raw.value);
  if (!data)
    return { status: "invalid", source: { source, path, status: "invalid" } };
  const oauth =
    data.claudeAiOauth && typeof data.claudeAiOauth === "object"
      ? (data.claudeAiOauth as Record<string, unknown>)
      : data;
  const accessToken =
    stringValue(oauth.accessToken) ?? stringValue(oauth.access_token);
  if (!accessToken)
    return { status: "invalid", source: { source, path, status: "invalid" } };
  const expiresAt = expiresAtMillis(oauth.expiresAt);
  const plan =
    stringValue(oauth.subscriptionType) ?? stringValue(data.subscriptionType);
  const credentials = { source, accessToken, plan, expiresAt };
  if (expiresAt !== undefined && expiresAt <= Date.now()) {
    return {
      status: "expired",
      credentials,
      source: { source, path, status: "expired" },
      refreshable: hasRefreshToken(oauth),
    };
  }
  return {
    status: "available",
    credentials,
  };
}

/**
 * Presence check only. The value of a Claude refresh token never enters
 * quota-axi: Anthropic rotates it on use, so exchanging it here would spend the
 * Claude CLI's own single-use token and sign the user out of Claude Code.
 */
function hasRefreshToken(oauth: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(oauth, "refreshToken") ||
    Object.hasOwn(oauth, "refresh_token")
  );
}

async function fetchOauthUsage(credentials: ClaudeCredentials): Promise<{
  plan?: string;
  account?: ProviderQuota["account"];
  identityError?: string;
  windows: QuotaWindow[];
  refreshedAt: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await providerFetch(API_URL, {
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        "anthropic-beta": OAUTH_BETA,
        "User-Agent": CLAUDE_CODE_USER_AGENT,
        "Content-Type": "application/json",
        accept: "application/json",
      },
      signal: controller.signal,
    });
    rejectUnusableUsageResponse(response);
    const quota = normalizeClaudeApiUsage(
      await response.json(),
      credentials.plan,
    );
    if (!quota) throw new Error("Claude quota unavailable");
    const identity = await fetchOauthProfile(credentials);
    return {
      ...quota,
      account: identity.account,
      identityError: identity.error,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOauthProfile(
  credentials: ClaudeCredentials,
): Promise<ClaudeIdentityResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await providerFetch(PROFILE_API_URL, {
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        "User-Agent": CLAUDE_CODE_USER_AGENT,
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return unverifiedClaudeIdentity(
        `identity_profile_http_${response.status}`,
      );
    }
    const account = normalizeClaudeProfile(await response.json());
    return account
      ? { account }
      : unverifiedClaudeIdentity("identity_profile_unrecognized");
  } catch (error) {
    return unverifiedClaudeIdentity(
      error instanceof Error && error.name === "AbortError"
        ? "identity_profile_timeout"
        : "identity_profile_unavailable",
    );
  } finally {
    clearTimeout(timer);
  }
}

function unverifiedClaudeIdentity(error: string): ClaudeIdentityResult {
  return {
    account: { identityStatus: "unverified" },
    error,
  };
}

// Anthropic's OAuth usage endpoint uses 401 for failed authentication. A 403
// can also be a network-policy or WAF denial, so it is not sufficient evidence
// for a sign-out verdict. 429 follows standard Retry-After semantics (RFC 9110).
function rejectUnusableUsageResponse(response: Response): void {
  if (response.status === 401) {
    throw new ClaudeFailure(CLAUDE_SIGN_IN_REQUIRED, {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (response.status === 429) {
    throw new ClaudeFailure("Claude quota endpoint rate limited", {
      status: "rate_limited",
      staleEligible: true,
      retryAfter: retryAfterToIso(response.headers.get("retry-after")),
    });
  }
  if (!response.ok) {
    throw new ClaudeFailure(`Claude quota unavailable (${response.status})`, {
      staleEligible: true,
    });
  }
}

function normalizeWindow(
  raw: unknown,
  id: string,
  label: string,
  kind: QuotaWindow["kind"],
  modelScope?: ModelWindowScope,
): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as RawUsageWindow;
  const used =
    typeof data.utilization === "number" ? data.utilization : undefined;
  if (used === undefined) return undefined;
  const windowSeconds = trustedClaudeWindowSeconds(id, kind);
  return withRemaining({
    id,
    label,
    kind,
    percentUsed: clampPercent(used),
    resetsAt: stringValue(data.resets_at) ?? stringValue(data.reset_at),
    ...(windowSeconds !== undefined ? { windowSeconds } : {}),
    ...(modelScope ? { modelScope } : {}),
  });
}

function trustedClaudeWindowSeconds(
  id: string,
  kind: QuotaWindow["kind"],
): number | undefined {
  if (id === "five_hour" || kind === "session") return FIVE_HOURS_SECONDS;
  if (
    id === "seven_day" ||
    id === "seven_day_opus" ||
    kind === "weekly" ||
    kind === "model"
  ) {
    return SEVEN_DAYS_SECONDS;
  }
  return undefined;
}

function normalizeExtraUsage(raw: unknown): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as ExtraUsageWindow;
  if (data.is_enabled !== true) return undefined;
  const decimalPlaces =
    typeof data.decimal_places === "number" ? data.decimal_places : 2;
  const minorUnitDivisor = 10 ** decimalPlaces;
  const spentUsd =
    typeof data.used_credits === "number"
      ? data.used_credits / minorUnitDivisor
      : undefined;
  const limitUsd =
    typeof data.monthly_limit === "number"
      ? data.monthly_limit / minorUnitDivisor
      : undefined;
  const percentUsed =
    typeof data.utilization === "number"
      ? clampPercent(data.utilization)
      : spentUsd !== undefined && limitUsd && limitUsd > 0
        ? clampPercent((spentUsd / limitUsd) * 100)
        : undefined;
  return withRemaining({
    id: "extra_usage",
    label: "extra usage",
    kind: "credits",
    percentUsed,
    spentUsd,
    limitUsd,
  });
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function expiresAtMillis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError")
    return "Claude quota request timed out";
  return error instanceof Error ? error.message : "Claude quota unavailable";
}

class ClaudeFailure extends Error {
  readonly status: ProviderStatus;
  readonly definitiveAuth: boolean;
  readonly staleEligible: boolean;
  readonly retryAfter: string | undefined;
  usageFetchFailure = false;

  constructor(
    readonly code: string,
    options: ClaudeFailureOptions = {},
  ) {
    super(code);
    this.name = "ClaudeFailure";
    this.status = options.status ?? statusFromError(code);
    this.definitiveAuth = options.definitiveAuth ?? false;
    this.staleEligible = options.staleEligible ?? false;
    this.retryAfter = options.retryAfter;
  }

  withUsageFetchFailure(): this {
    this.usageFetchFailure = true;
    return this;
  }
}

/**
 * Read Anthropic's own current model lineup.
 *
 * This is the vendor naming its models, which is the only thing that can carry
 * model identity: quota-axi's built-in catalog is editorial and goes stale
 * silently. Every outcome other than a listing the vendor actually returned is
 * `unavailable` with a reason, so the join discloses the gap rather than
 * passing off the built-in lineup as Anthropic's answer.
 *
 * It reuses the quota path's stored credentials read-only and never refreshes:
 * a model listing is not worth spending a single-use refresh-token exchange on,
 * and the quota read in the same run already owns that decision. When the run
 * shares a credential cache, it reuses that read's resolution rather than
 * resolving the store again - one macOS Keychain value read per command, and
 * one account answering both halves - and it never presents a credential that
 * read already watched Anthropic reject.
 *
 * Only a 401 moves to the next credential, the same status the usage read
 * treats as definitive; every other failure, 403 included, stops there, because
 * promoting a sibling store on a WAF denial or a 503 could publish one
 * account's lineup beside another account's windows.
 */
export async function fetchModelCatalog(
  options: ProviderOptions,
): Promise<LiveModelCatalog> {
  const { usable: candidates, rejected } = partitionRejectedCandidates(
    orderedCredentialCandidates(await readCredentialStates(options)),
    options.credentialCache,
  );
  if (candidates.length === 0) {
    return {
      provider: "claude",
      status: "unavailable",
      // A credential the quota read watched Anthropic reject is withheld, not
      // absent: the listing endpoint never sees it, and the gap is disclosed
      // as the rejection it is rather than as a missing store.
      reason:
        rejected.length > 0 ? CREDENTIAL_REJECTED_THIS_RUN : "no_credential",
    };
  }

  let reason = "catalog_unavailable";
  for (const state of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const response = await providerFetch(MODELS_API_URL, {
        headers: {
          authorization: `Bearer ${state.credentials.accessToken}`,
          "anthropic-beta": OAUTH_BETA,
          "anthropic-version": MODELS_API_VERSION,
          "User-Agent": CLAUDE_CODE_USER_AGENT,
          accept: "application/json",
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        reason = `catalog_http_${response.status}`;
        if (response.status === 401) {
          // Anthropic's own definitive rejection, the same status the usage
          // read treats as definitive, so this bearer is latched closed for
          // the rest of the run rather than only for this loop.
          options.credentialCache?.rejectCredential(
            claudeCredentialId(state.credentials),
          );
          continue;
        }
        break;
      }
      const payload: unknown = await response.json();
      const models = normalizeClaudeModelCatalog(payload);
      if (models.length === 0) {
        reason = "catalog_unrecognized";
        break;
      }
      return {
        provider: "claude",
        status: "live",
        fetchedAt: nowIso(),
        models,
        ...(claudeModelCatalogIsTruncated(payload) ? { truncated: true } : {}),
      };
    } catch (error) {
      reason =
        error instanceof Error && error.name === "AbortError"
          ? "catalog_timeout"
          : "catalog_unreachable";
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  return { provider: "claude", status: "unavailable", reason };
}

/**
 * Whether the vendor said this page is not the whole lineup. quota-axi does not
 * follow the vendor's pages here; it discloses that what it read is partial so
 * an incomplete lineup is never published as the vendor's complete answer.
 */
export function claudeModelCatalogIsTruncated(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  return (payload as { has_more?: unknown }).has_more === true;
}

/** Accept only records that carry the vendor's own id; never invent a label. */
export function normalizeClaudeModelCatalog(
  payload: unknown,
): LiveModelRecord[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const models: LiveModelRecord[] = [];
  for (const record of data) {
    if (!record || typeof record !== "object") continue;
    const { id, display_name: displayName } = record as {
      id?: unknown;
      display_name?: unknown;
    };
    if (typeof id !== "string" || !id.trim()) continue;
    models.push({
      id,
      label:
        typeof displayName === "string" && displayName.trim()
          ? displayName
          : id,
    });
  }
  return models;
}

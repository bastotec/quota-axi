import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import { readCachedProvider } from "../cache.js";
import { readJsonFileResult, type JsonFileReadResult } from "../lib/fs.js";
import { providerFetch } from "../lib/http.js";
import { findCommandPath, terminateChild } from "../lib/process.js";
import {
  clampPercent,
  nowIso,
  parseEpochOrIso,
  retryAfterToIso,
} from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import type { LocalCredentialEvidence } from "./common.js";
import {
  failedProvider,
  localCredentialReason,
  strongerEvidence,
  sourceNames,
  staleFromCache,
  statusFromError,
  successProvider,
  withRemaining,
} from "./common.js";
import {
  selectCredential,
  type AttemptOutcome,
  type CredentialCandidate,
  type CredentialSelection,
} from "./credential-selection.js";
import {
  createPiCodexCredentialBroker,
  type PiCodexCredentialBroker,
  type PiCodexCredentialInspection,
  type PiCodexCredentialResolution,
} from "./pi-codex-credential.js";

/**
 * `backend-api/codex/usage` used to sit here as a second candidate and is
 * deliberately gone. It never answered: it returns a Cloudflare bot-management
 * interstitial (403, `cf-mitigated: challenge`, HTML) identically for a valid
 * bearer, a different account's bearer, and no credential at all, so the
 * credential is never examined and no reading can come back. Restoring it
 * would cost every Codex failure a round-trip that can only ever yield that
 * challenge - and worse, this loop reads 403 as a rejection, so the one thing
 * the dead entry can contribute is a WAF challenge dressed as the user's
 * sign-in verdict.
 */
const ENDPOINTS = ["https://chatgpt.com/backend-api/wham/usage"];
const API_TIMEOUT_MS = 15_000;
const CLI_TIMEOUT_MS = 15_000;
const RPC_TIMEOUT_MS = 8_000;
const CODEX_BINARY_ENV = "QUOTA_AXI_CODEX_BINARY";
const PI_CODEX_CREDENTIAL_SOURCE = "pi:openai-codex";

type CodexBinaryState =
  | { status: "available"; path: string }
  | { status: "missing"; path?: string; error?: string };

type CodexCredentials = {
  accessToken: string;
  accountId?: string;
};

type AvailableCredentialState = {
  status: "available";
  credentials: CodexCredentials;
  source: AuthSourceReport;
};
/**
 * Stored-expired, and still carrying its credentials so the bounded read-only
 * quota probe tests it in its source's declared position. The endpoint, not
 * the store's own field, decides the verdict.
 */
type AdvisoryExpiredCredentialState = {
  status: "expired";
  credentials: CodexCredentials;
  source: AuthSourceReport;
};
/**
 * `unreadable` is a store quota-axi could not open at all - permissions, a
 * directory in its place. It says nothing about what the file holds, so it is
 * neither an auth verdict nor evidence about a credential, mirroring Z.AI's
 * `error` resolution.
 */
type UnavailableCredentialState = {
  status: "missing" | "invalid" | "unreadable";
  source: AuthSourceReport;
};
type CredentialState =
  | AvailableCredentialState
  | AdvisoryExpiredCredentialState
  | UnavailableCredentialState;

/** Opaque attempt payload for the shared credential-selection loop. */
type CodexAttemptCredential = {
  source: ProviderQuota["source"];
  credentials: CodexCredentials;
};

type NormalizedCodexQuota = {
  plan?: string;
  account?: ProviderQuota["account"];
  windows: QuotaWindow[];
  credits?: ProviderQuota["credits"];
  refreshedAt: string;
};

type RawWindow = {
  used_percent?: unknown;
  usedPercent?: unknown;
  reset_at?: unknown;
  resetsAt?: unknown;
  reset_after_seconds?: unknown;
  limit_window_seconds?: unknown;
  windowDurationMins?: unknown;
};

type CodexDependencies = {
  piCodexBroker: PiCodexCredentialBroker;
};

const defaultCodexDependencies: CodexDependencies = {
  piCodexBroker: createPiCodexCredentialBroker(),
};

export function createCodexAdapter(
  overrides: Partial<CodexDependencies> = {},
): ProviderAdapter {
  const dependencies: CodexDependencies = {
    ...defaultCodexDependencies,
    ...overrides,
  };
  return {
    id: "codex",
    label: "Codex",
    fetchQuota: (_options) => fetchQuotaWithDependencies(dependencies),
    inspectAuth: (_options) => inspectAuthWithDependencies(dependencies),
  };
}

export const codexAdapter = createCodexAdapter();

export async function fetchQuota(
  _options: ProviderOptions,
): Promise<ProviderQuota> {
  return fetchQuotaWithDependencies(defaultCodexDependencies);
}

async function fetchQuotaWithDependencies(
  dependencies: CodexDependencies,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let finalError = "Codex quota unavailable";
  // False once a source has recorded a real failure. Sources are consulted in
  // priority order, so a lower-priority one may only name the failure while
  // this still holds: a native probe that timed out has already explained the
  // run, and letting an expired Pi entry restate it as an auth problem would
  // make statusFromError advise a sign-in for what is a network outage.
  let errorIsDefault = true;
  // What this run established about a local credential, strengthening as
  // sources are read. While it stays `none` the run has established nothing
  // about the account: see `localCredentialReason`.
  let evidence: LocalCredentialEvidence = "none";

  const credentialState = readCredentialState();
  const oauthCandidates: CredentialCandidate<CodexAttemptCredential>[] = [];
  if (
    credentialState.status === "available" ||
    credentialState.status === "expired"
  ) {
    evidence = strongerEvidence(evidence, "tested");
    oauthCandidates.push({
      source: "oauth",
      localState: credentialState.status === "available" ? "valid" : "expired",
      credential: { source: "oauth", credentials: credentialState.credentials },
    });
  } else {
    attempts.push({
      source: "oauth",
      status: credentialState.status === "unreadable" ? "failed" : "skipped",
      error: `credentials_${credentialState.status}`,
      // A store that exists still stands between this run and a credential, so
      // a sibling source that answers supersedes it rather than replacing it
      // silently.
      ...(credentialState.status === "missing"
        ? {}
        : { credentialPresent: true }),
    });
    if (credentialState.status === "missing") {
      // No store to read is not a sign-out. It stays `auth_required` because a
      // credential is still what this read needs, but it must not claim the
      // account is signed out on evidence the run never gathered.
      finalError = "Codex credential required";
    } else if (credentialState.status === "unreadable") {
      // The file was never opened, so nothing is known about what it holds:
      // not an auth verdict, and not a claim that it holds no login.
      finalError = "Codex auth.json could not be read; check its permissions";
    } else {
      // The store was read and yielded nothing this adapter can send, so no
      // endpoint examined a credential: that is a stored-credential problem,
      // not a sign-out.
      evidence = strongerEvidence(evidence, "unusable");
      finalError =
        "Codex credential required; local store holds no usable ChatGPT login";
    }
    errorIsDefault = false;
  }

  const oauthSelection = await selectCredential(oauthCandidates, (candidate) =>
    attemptCodexCandidate(candidate.credential),
  );
  appendSelectionAttempts(attempts, oauthSelection);
  if (oauthSelection.outcome === "quota") {
    return codexSuccessReport(oauthSelection.result!, "oauth", attempts);
  }
  if (oauthSelection.outcome === "transient") {
    // The request failed, not the credential, so a sibling credential is not
    // consulted: it would answer a question this run never got to ask.
    return codexFailureReport(
      oauthSelection.transientError ?? finalError,
      oauthSelection.retryAfter,
      attempts,
      "oauth",
    );
  }
  if (oauthSelection.outcome === "all_rejected") {
    finalError = "Codex sign-in required";
    errorIsDefault = false;
  }

  let piResolution: PiCodexCredentialResolution;
  try {
    piResolution = await dependencies.piCodexBroker.resolve();
  } catch {
    piResolution = { status: "error" };
  }
  const piCandidates: CredentialCandidate<CodexAttemptCredential>[] = [];
  if (piResolution.status === "available") {
    evidence = strongerEvidence(evidence, "tested");
    piCandidates.push({
      source: PI_CODEX_CREDENTIAL_SOURCE,
      localState: "valid",
      credential: {
        source: PI_CODEX_CREDENTIAL_SOURCE,
        credentials: piResolution.credentials,
      },
    });
  } else if (
    piResolution.status === "expired" &&
    piResolution.credentials !== undefined
  ) {
    evidence = strongerEvidence(evidence, "tested");
    piCandidates.push({
      source: PI_CODEX_CREDENTIAL_SOURCE,
      localState: "expired",
      refreshable: piResolution.refreshable,
      credential: {
        source: PI_CODEX_CREDENTIAL_SOURCE,
        credentials: piResolution.credentials,
      },
    });
  } else {
    const piAttempt = piSourceAttempt(piResolution);
    if (piAttempt.credentialPresent)
      evidence = strongerEvidence(evidence, "unusable");
    attempts.push(piAttempt);
    if (
      piResolution.status === "error" &&
      (errorIsDefault || statusFromError(finalError) === "auth_required")
    ) {
      finalError = "Codex Pi credential resolution failed";
      errorIsDefault = false;
    } else if (errorIsDefault) {
      if (piResolution.status === "expired") {
        // Expired and unprobeable: the store held no token to test.
        finalError = "Pi Codex access token expired";
        errorIsDefault = false;
      } else if (piResolution.status !== "missing") {
        finalError = "Codex sign-in required";
        errorIsDefault = false;
      }
    }
  }

  const piSelection = await selectCredential(piCandidates, (candidate) =>
    attemptCodexCandidate(candidate.credential),
  );
  appendSelectionAttempts(attempts, piSelection);
  if (piSelection.outcome === "quota") {
    return codexSuccessReport(
      piSelection.result!,
      PI_CODEX_CREDENTIAL_SOURCE,
      attempts,
    );
  }
  if (piSelection.outcome === "transient") {
    return codexFailureReport(
      piSelection.transientError ?? finalError,
      piSelection.retryAfter,
      attempts,
      PI_CODEX_CREDENTIAL_SOURCE,
    );
  }
  if (piSelection.outcome === "all_rejected") {
    if (errorIsDefault || statusFromError(finalError) === "auth_required") {
      finalError = "Codex sign-in required";
      errorIsDefault = false;
    }
  }

  attempts.push({ source: "cli-rpc", status: "failed" });
  try {
    const quota = await probeCodexCli();
    attempts[attempts.length - 1] = { source: "cli-rpc", status: "success" };
    return successProvider({
      provider: "codex",
      label: "Codex",
      source: "cli-rpc",
      plan: quota.plan,
      account: quota.account,
      windows: quota.windows,
      credits: quota.credits,
      refreshedAt: quota.refreshedAt,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  } catch (error) {
    const message = errorMessage(error);
    attempts[attempts.length - 1] = {
      source: "cli-rpc",
      status: "failed",
      error: message,
    };
    if (errorIsDefault || !(error instanceof CodexCliUnavailableError)) {
      finalError = message;
    }
  }

  return codexFailureReport(
    finalError,
    undefined,
    attempts,
    undefined,
    evidence,
  );
}

/**
 * One bounded read-only probe of a single credential. The endpoint, not the
 * store's expiry field, decides: only a definitive rejection is an auth
 * verdict, and everything else is transport-class trouble that must not
 * trigger credential switching.
 */
async function attemptCodexCandidate(
  candidate: CodexAttemptCredential,
): Promise<AttemptOutcome<NormalizedCodexQuota>> {
  try {
    return {
      kind: "quota",
      result: await fetchOauthUsage(candidate.credentials),
    };
  } catch (error) {
    const message = credentialSafeErrorMessage(
      error,
      candidate.credentials.accessToken,
    );
    if (error instanceof RateLimitError) {
      return {
        kind: "transient",
        error: message,
        retryAfter: error.retryAfter,
      };
    }
    return error instanceof CodexAuthRejectedError
      ? { kind: "rejected", error: message }
      : { kind: "transient", error: message };
  }
}

/**
 * Record what each consulted credential did. A candidate the loop never
 * reached is deliberately left out: an unconsulted source is not a broken
 * one, and naming it would raise a `degraded_source` row for a store that
 * was simply not needed.
 */
function appendSelectionAttempts(
  attempts: SourceAttempt[],
  selection: CredentialSelection<NormalizedCodexQuota>,
): void {
  for (const result of selection.results) {
    if (result.outcome === "not_tried") continue;
    attempts.push(
      result.outcome === "quota"
        ? { source: result.source, status: "success" }
        : {
            source: result.source,
            status: "failed",
            ...(result.error ? { error: result.error } : {}),
          },
    );
  }
}

function codexSuccessReport(
  quota: NormalizedCodexQuota,
  source: ProviderQuota["source"],
  attempts: SourceAttempt[],
): ProviderQuota {
  return successProvider({
    provider: "codex",
    label: "Codex",
    source,
    plan: quota.plan,
    account: quota.account,
    windows: quota.windows,
    credits: quota.credits,
    refreshedAt: quota.refreshedAt,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

/**
 * `evidence` defaults to `tested` so a caller that does not track it can never
 * publish a reach claim by omission: `no_local_credential` and
 * `local_credential_unusable` are only reported where the run actually
 * established that no store held a credential, or that none held a usable one.
 */
function codexFailureReport(
  error: string,
  retryAfter: string | undefined,
  attempts: SourceAttempt[],
  source?: ProviderQuota["source"],
  evidence: LocalCredentialEvidence = "tested",
): ProviderQuota {
  const cached = readCachedProvider("codex");
  if (cached) {
    return staleFromCache(cached, error, sourceNames(attempts), attempts);
  }
  const status = retryAfter ? "rate_limited" : statusFromError(error);
  return failedProvider({
    provider: "codex",
    label: "Codex",
    ...(source ? { source } : {}),
    status,
    error,
    retryAfter,
    reason: localCredentialReason(status, evidence),
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

export async function inspectAuth(
  _options: ProviderOptions,
): Promise<AuthProviderReport> {
  return inspectAuthWithDependencies(defaultCodexDependencies);
}

async function inspectAuthWithDependencies(
  dependencies: CodexDependencies,
): Promise<AuthProviderReport> {
  const authFile = codexAuthFile();
  const credentialState = readCredentialState(authFile);
  let piSource: AuthSourceReport;
  try {
    piSource = piInspectionSource(await dependencies.piCodexBroker.inspect());
  } catch {
    piSource = {
      source: PI_CODEX_CREDENTIAL_SOURCE,
      status: "error",
      error: "credential_resolution_failed",
    };
  }
  const binary = await resolveCodexBinary();
  return {
    provider: "codex",
    sources: [
      credentialState.source,
      piSource,
      {
        source: "cli-rpc",
        path: binary.path,
        status: binary.status,
        error: binary.status === "missing" ? binary.error : undefined,
      },
    ],
  };
}

function piSourceAttempt(
  resolution: Exclude<PiCodexCredentialResolution, { status: "available" }>,
): SourceAttempt {
  if (resolution.status === "error") {
    return {
      source: PI_CODEX_CREDENTIAL_SOURCE,
      status: "failed",
      error: "credential_resolution_failed",
      credentialPresent: true,
    };
  }
  if (resolution.status === "expired") {
    return {
      source: PI_CODEX_CREDENTIAL_SOURCE,
      status: "skipped",
      error: resolution.refreshable
        ? "credentials_expired_refreshable"
        : "credentials_expired",
      credentialPresent: true,
    };
  }
  const error =
    resolution.status === "missing"
      ? "credentials_missing"
      : resolution.status === "unsupported"
        ? "unsupported_credential_type"
        : "credentials_invalid";
  return {
    source: PI_CODEX_CREDENTIAL_SOURCE,
    status: "skipped",
    error,
    ...(resolution.status === "missing" ? {} : { credentialPresent: true }),
  };
}

function piInspectionSource(
  inspection: PiCodexCredentialInspection,
): AuthSourceReport {
  const status: AuthSourceReport["status"] =
    inspection.status === "available" ||
    inspection.status === "missing" ||
    inspection.status === "expired" ||
    inspection.status === "error"
      ? inspection.status
      : "invalid";
  return {
    source: PI_CODEX_CREDENTIAL_SOURCE,
    path: inspection.path,
    status,
    ...(inspection.error ? { error: inspection.error } : {}),
  };
}

export function normalizeCodexUsage(raw: unknown):
  | {
      plan?: string;
      account?: ProviderQuota["account"];
      windows: QuotaWindow[];
      credits?: ProviderQuota["credits"];
      refreshedAt: string;
    }
  | undefined {
  // Both the direct ChatGPT backend calls and the codex app-server RPC
  // describe the same rate-limit concepts, but the RPC surface uses
  // camelCase field names while the HTTP backend uses snake_case; both
  // forms are tolerated wherever they appear below.
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as Record<string, unknown>;
  const rateLimit = resolveRateLimitContainer(data);

  const windows = deduplicateWindowIds([
    ...windowPairFromContainer(
      rateLimit,
      "five_hour",
      "session",
      "session",
      "weekly",
      "week",
      "weekly",
    ),
    ...windowPairFromContainer(
      objectValue(data.code_review_rate_limit),
      "code_review_five_hour",
      "code review session",
      "session",
      "code_review_weekly",
      "code review week",
      "weekly",
    ),
    ...collectNamedRateLimitWindows(data),
  ]);

  if (windows.length === 0) return undefined;

  return {
    plan: stringValue(data.plan_type) ?? stringValue(data.planType),
    account: {
      email: stringValue(data.email),
      accountId: stringValue(data.account_id) ?? stringValue(data.accountId),
    },
    windows,
    credits: normalizeCredits(data.credits ?? rateLimit?.credits),
    refreshedAt: nowIso(),
  };
}

function resolveRateLimitContainer(
  data: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return (
    objectValue(data.rate_limit) ??
    objectValue(data.rateLimits) ??
    objectValue(data.rate_limits) ??
    data
  );
}

type WindowIdentity = Pick<QuotaWindow, "id" | "label" | "kind" | "modelScope">;

type WindowIdentitySet = {
  session: WindowIdentity;
  weekly: WindowIdentity;
  unfamiliar(windowSeconds: number): WindowIdentity;
};

function windowPairFromContainer(
  container: Record<string, unknown> | undefined,
  primaryId: string,
  primaryLabel: string,
  primaryKind: QuotaWindow["kind"],
  secondaryId: string,
  secondaryLabel: string,
  secondaryKind: QuotaWindow["kind"],
): QuotaWindow[] {
  if (!container) return [];
  const identities: WindowIdentitySet = {
    session: { id: primaryId, label: primaryLabel, kind: primaryKind },
    weekly: { id: secondaryId, label: secondaryLabel, kind: secondaryKind },
    unfamiliar(windowSeconds) {
      const duration = readableWindowDuration(windowSeconds);
      const prefix =
        primaryId === "five_hour" ? "window" : "code_review_window";
      return {
        id: `${prefix}:${duration}`,
        label: `${duration} window`,
        kind: "unknown",
      };
    },
  };
  return [
    normalizeWindow(
      container.primary_window ?? container.primary,
      identities.session,
      identities,
    ),
    normalizeWindow(
      container.secondary_window ?? container.secondary,
      identities.weekly,
      identities,
    ),
  ].filter((window): window is QuotaWindow => Boolean(window));
}

// Beyond the base rate limit, both API shapes can carry extra limits scoped
// to a specific model or feature (e.g. a preview model with its own budget):
// the HTTP backend lists them under `additional_rate_limits`, keyed by
// `metered_feature`/`limit_name`; the app-server RPC exposes an equivalent
// `rateLimitsByLimitId` map keyed by limit id, where only the named entries
// are extras (the unnamed one duplicates the base limit already parsed above).
//
// Both shapes also carry the vendor's own model slug for the bucket - the HTTP
// one as `normal_model_slug`, the RPC one as `normalModelSlug`, which the
// vendor documents as "the normal model whose display name and reasoning
// options describe this quota alias". It is read here so a named bucket's model
// identity is the vendor's statement rather than a guess about what its opaque
// limit id means.
function collectNamedRateLimitWindows(
  data: Record<string, unknown>,
): QuotaWindow[] {
  const windows: QuotaWindow[] = [];

  const additional = Array.isArray(data.additional_rate_limits)
    ? data.additional_rate_limits
    : [];
  for (const entry of additional) {
    const item = objectValue(entry);
    if (!item) continue;
    const id =
      stringValue(item.metered_feature) ?? stringValue(item.limit_name);
    const label = stringValue(item.limit_name) ?? id;
    const container = objectValue(item.rate_limit);
    if (!id || !label || !container) continue;
    windows.push(
      ...namedLimitWindows(id, label, container, normalModelSlug(item)),
    );
  }

  const byLimitId = objectValue(data.rateLimitsByLimitId);
  if (byLimitId) {
    for (const [limitId, value] of Object.entries(byLimitId)) {
      const item = objectValue(value);
      if (!item) continue;
      const label = stringValue(item.limitName) ?? stringValue(item.limit_name);
      if (!label) continue;
      windows.push(
        ...namedLimitWindows(limitId, label, item, normalModelSlug(item)),
      );
    }
  }

  return windows;
}

/** The vendor's own model slug for a metered bucket, in either field spelling. */
function normalModelSlug(item: Record<string, unknown>): string | undefined {
  return (
    stringValue(item.normal_model_slug) ?? stringValue(item.normalModelSlug)
  );
}

function namedLimitWindows(
  id: string,
  label: string,
  container: Record<string, unknown>,
  modelSlug?: string,
): QuotaWindow[] {
  // The vendor's own metered-feature or limit id is the scope's identity, which
  // every period of that limit shares. A limit id such as `codex_bengalfox` is
  // an opaque bucket name, not a model name, so a model id is asserted only
  // when the vendor sent one; what is always carried is the vendor's own name
  // for the limit.
  const scope = {
    id: `model:${id}`,
    ...(modelSlug ? { modelId: modelSlug } : {}),
    name: label,
  } as const;
  const identities: WindowIdentitySet = {
    session: {
      id: `model:${id}:5h`,
      label: `${label} session`,
      kind: "model",
      modelScope: scope,
    },
    weekly: {
      id: `model:${id}:7d`,
      label: `${label} week`,
      kind: "model",
      modelScope: scope,
    },
    unfamiliar(windowSeconds) {
      const duration = readableWindowDuration(windowSeconds);
      return {
        id: `model:${id}:window:${duration}`,
        label: `${label} ${duration} window`,
        kind: "model",
        modelScope: scope,
      };
    },
  };
  return [
    normalizeWindow(
      container.primary_window ?? container.primary,
      identities.session,
      identities,
    ),
    normalizeWindow(
      container.secondary_window ?? container.secondary,
      identities.weekly,
      identities,
    ),
  ].filter((window): window is QuotaWindow => Boolean(window));
}

/**
 * Number repeats of an identical vendor window id. The scope identity itself is
 * untouched: a repeat bounds the same scope as the window it repeats.
 */
function deduplicateWindowIds(windows: QuotaWindow[]): QuotaWindow[] {
  const counts = new Map<string, number>();
  return windows.map((window) => {
    const count = (counts.get(window.id) ?? 0) + 1;
    counts.set(window.id, count);
    if (count === 1) return window;
    return { ...window, id: `${window.id}_${count}` };
  });
}

export function mergeAccountAndLimits(
  account: unknown,
  limits: unknown,
): Record<string, unknown> {
  const accountData = objectValue(account) ?? {};
  const accountRecord = objectValue(accountData.account) ?? accountData;
  const limitData = objectValue(limits) ?? {};
  return {
    ...limitData,
    email: accountRecord.email ?? limitData.email,
    account_id:
      accountRecord.account_id ??
      accountRecord.accountId ??
      limitData.account_id,
    plan_type:
      accountRecord.plan_type ?? accountRecord.planType ?? limitData.plan_type,
  };
}

function codexAuthFile(): string {
  return process.env.CODEX_HOME
    ? join(process.env.CODEX_HOME, "auth.json")
    : join(homedir(), ".codex", "auth.json");
}

function readCredentialState(authFile = codexAuthFile()): CredentialState {
  return extractCredentialState(readJsonFileResult(authFile), authFile);
}

function extractCredentialState(
  raw: JsonFileReadResult,
  path: string,
): CredentialState {
  if (raw.status === "missing")
    return {
      status: "missing",
      source: { source: "auth-json", path, status: "missing" },
    };
  if (raw.status === "invalid")
    return raw.error === "file_read_error"
      ? {
          status: "unreadable",
          source: {
            source: "auth-json",
            path,
            status: "error",
            error: raw.error,
          },
        }
      : {
          status: "invalid",
          source: {
            source: "auth-json",
            path,
            status: "invalid",
            error: raw.error,
          },
        };
  const data = objectValue(raw.value);
  if (!data)
    return {
      status: "invalid",
      source: { source: "auth-json", path, status: "invalid" },
    };
  const tokens = objectValue(data.tokens);
  if (!tokens)
    return {
      status: "invalid",
      source: { source: "auth-json", path, status: "invalid" },
    };
  const accessToken =
    stringValue(tokens.access_token) ?? stringValue(tokens.accessToken);
  if (!accessToken)
    return {
      status: "invalid",
      source: { source: "auth-json", path, status: "invalid" },
    };

  // Access-token usability is authoritative for bearer API access. Identity
  // token expiry alone is diagnostic metadata and must not skip OAuth.
  const idToken = stringValue(tokens.id_token) ?? stringValue(tokens.idToken);
  const idPayload = decodeJwtPayload(idToken);
  const accessPayload = decodeJwtPayload(accessToken);
  const decoded = idPayload ?? accessPayload;
  const accountId =
    stringValue(tokens.account_id) ??
    stringValue(tokens.accountId) ??
    stringValue(decoded?.["https://api.openai.com/auth/account_id"]) ??
    stringValue(decoded?.account_id);
  const credentials: CodexCredentials = { accessToken, accountId };
  // Stored expiry is liveness metadata only. The credential is still probed
  // in its source's declared position, and only the endpoint decides.
  if (isExpiredJwtPayload(accessPayload)) {
    return {
      status: "expired",
      credentials,
      source: { source: "auth-json", path, status: "expired" },
    };
  }
  return {
    status: "available",
    credentials,
    source: { source: "auth-json", path, status: "available" },
  };
}

async function fetchOauthUsage(credentials: CodexCredentials): Promise<{
  plan?: string;
  account?: ProviderQuota["account"];
  windows: QuotaWindow[];
  credits?: ProviderQuota["credits"];
  refreshedAt: string;
}> {
  let rejected = false;
  let lastError: unknown;
  for (const endpoint of ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${credentials.accessToken}`,
        accept: "application/json",
      };
      if (credentials.accountId)
        headers["ChatGPT-Account-Id"] = credentials.accountId;
      const response = await providerFetch(endpoint, {
        headers,
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        rejected = true;
        continue;
      }
      if (response.status === 429)
        throw new RateLimitError(
          retryAfterToIso(response.headers.get("retry-after")),
        );
      if (!response.ok) {
        lastError = new Error("Codex quota unavailable");
        continue;
      }
      const quota = normalizeCodexUsage(await response.json());
      if (quota) return quota;
      lastError = new Error("Codex quota unavailable");
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastError) throw lastError;
  if (rejected) throw new CodexAuthRejectedError("Codex sign-in required");
  throw new Error("Codex quota unavailable");
}

async function probeCodexCli(): Promise<{
  plan?: string;
  account?: ProviderQuota["account"];
  windows: QuotaWindow[];
  credits?: ProviderQuota["credits"];
  refreshedAt: string;
}> {
  const binary = await resolveCodexBinary();
  if (binary.status === "missing") {
    throw new CodexCliUnavailableError(codexBinaryErrorMessage(binary));
  }
  const child = spawn(
    binary.path,
    ["-s", "read-only", "-a", "untrusted", "app-server"],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
    },
  );

  let nextId = 1;
  let buffer = "";
  let fatalError: Error | undefined;
  const responses = new Map<number, unknown>();
  const waiters = new Map<
    number,
    {
      timer: NodeJS.Timeout;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();

  const failAll = (error: Error) => {
    if (fatalError) return;
    fatalError = error;
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    waiters.clear();
  };

  child.stdin.on("error", () => {});
  child.stderr.resume();
  child.on("error", () => failAll(new Error("Codex quota unavailable")));
  child.on("close", () => failAll(new Error("Codex quota unavailable")));

  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as {
          id?: unknown;
          result?: unknown;
          params?: unknown;
          error?: unknown;
        };
        if (typeof message.id !== "number") continue;
        const value = message.error ?? message.result ?? message.params;
        const waiter = waiters.get(message.id);
        if (waiter) {
          waiters.delete(message.id);
          clearTimeout(waiter.timer);
          waiter.resolve(value);
        } else {
          responses.set(message.id, value);
        }
      } catch {
        // Ignore non-JSON startup output.
      }
    }
  });

  const waitFor = (id: number, timeoutMs: number) =>
    new Promise<unknown>((resolve, reject) => {
      if (responses.has(id)) {
        resolve(responses.get(id));
        return;
      }
      if (fatalError) {
        reject(fatalError);
        return;
      }
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error("Codex quota unavailable"));
      }, timeoutMs);
      waiters.set(id, { timer, resolve, reject });
    });

  try {
    const initId = nextId++;
    sendRpc(child, initId, "initialize", {
      clientInfo: { name: "quota-axi", version: "1" },
    });
    await waitFor(initId, CLI_TIMEOUT_MS);

    const accountId = nextId++;
    sendRpc(child, accountId, "account/read");
    const account = await waitFor(accountId, RPC_TIMEOUT_MS).catch(
      () => undefined,
    );

    const limitsId = nextId++;
    sendRpc(child, limitsId, "account/rateLimits/read");
    const limits = await waitFor(limitsId, RPC_TIMEOUT_MS);
    const quota = normalizeCodexUsage(mergeAccountAndLimits(account, limits));
    if (!quota) throw new Error("Codex quota unavailable");
    return quota;
  } finally {
    terminateChild(child);
  }
}

async function resolveCodexBinary(): Promise<CodexBinaryState> {
  const configured = process.env[CODEX_BINARY_ENV];
  if (configured !== undefined) {
    const path = configured.trim();
    if (!path || !isAbsolute(path)) {
      return {
        status: "missing",
        error: "codex_binary_override_not_absolute",
      };
    }
    const executable = await findCommandPath(path);
    if (!executable) {
      return {
        status: "missing",
        path,
        error: "codex_binary_override_not_executable",
      };
    }
    return { status: "available", path: executable };
  }

  const executable = await findCommandPath("codex");
  return executable
    ? { status: "available", path: executable }
    : { status: "missing" };
}

function codexBinaryErrorMessage(
  binary: Extract<CodexBinaryState, { status: "missing" }>,
): string {
  if (binary.error === "codex_binary_override_not_absolute") {
    return "Configured Codex binary must be an absolute executable path";
  }
  if (binary.error === "codex_binary_override_not_executable") {
    return "Configured Codex binary is not executable";
  }
  return "Codex quota unavailable";
}

function sendRpc(
  child: { stdin: { writable: boolean; write: (chunk: string) => unknown } },
  id: number,
  method: string,
  params: unknown = {},
) {
  if (!child.stdin.writable) return;
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
}

function normalizeWindow(
  raw: unknown,
  fallbackIdentity: WindowIdentity,
  identities: WindowIdentitySet,
): QuotaWindow | undefined {
  const data = objectValue(raw) as RawWindow | undefined;
  if (!data) return undefined;
  const used = numberValue(data.used_percent) ?? numberValue(data.usedPercent);
  if (used === undefined) return undefined;
  const windowSeconds =
    numberValue(data.limit_window_seconds) ??
    (numberValue(data.windowDurationMins) === undefined
      ? undefined
      : numberValue(data.windowDurationMins)! * 60);
  const resetFromSeconds =
    numberValue(data.reset_after_seconds) === undefined
      ? undefined
      : new Date(
          Date.now() + numberValue(data.reset_after_seconds)! * 1000,
        ).toISOString();
  const identity = windowIdentity(windowSeconds, fallbackIdentity, identities);
  return withRemaining({
    ...identity,
    percentUsed: clampPercent(used),
    resetsAt:
      parseEpochOrIso(data.reset_at) ??
      parseEpochOrIso(data.resetsAt) ??
      resetFromSeconds,
    windowSeconds,
  });
}

function windowIdentity(
  windowSeconds: number | undefined,
  fallbackIdentity: WindowIdentity,
  identities: WindowIdentitySet,
): WindowIdentity {
  if (windowSeconds === undefined) return fallbackIdentity;
  if (windowSeconds === 18_000) return identities.session;
  if (windowSeconds === 604_800) return identities.weekly;
  return identities.unfamiliar(windowSeconds);
}

function readableWindowDuration(windowSeconds: number): string {
  const hours = windowSeconds / 3600;
  return `${Number.isInteger(hours) ? hours : Number(hours.toFixed(2))}h`;
}

function normalizeCredits(raw: unknown): ProviderQuota["credits"] | undefined {
  const data = objectValue(raw);
  if (!data) return undefined;
  const balance = numberValue(data.balance);
  const unlimited =
    typeof data.unlimited === "boolean" ? data.unlimited : undefined;
  if (balance === undefined && unlimited === undefined) return undefined;
  return {
    remaining: balance,
    unlimited,
    unit: "credits",
  };
}

function decodeJwtPayload(
  token: string | undefined,
): Record<string, unknown> | undefined {
  if (!token) return undefined;
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

function isExpiredJwtPayload(
  payload: Record<string, unknown> | undefined,
): boolean {
  const exp = numberValue(payload?.exp);
  return exp !== undefined && exp <= Math.floor(Date.now() / 1000);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function credentialSafeErrorMessage(
  error: unknown,
  credential: string,
): string {
  return errorMessage(error).replaceAll(credential, "[redacted]");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError")
    return "Codex quota request timed out";
  return error instanceof Error ? error.message : "Codex quota unavailable";
}

/** Definitive 401/403 from the quota endpoint: an auth verdict, not transport. */
class CodexAuthRejectedError extends Error {}

class CodexCliUnavailableError extends Error {}

class RateLimitError extends Error {
  constructor(readonly retryAfter: string | undefined) {
    super("Codex quota endpoint rate limited");
  }
}

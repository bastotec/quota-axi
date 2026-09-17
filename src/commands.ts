import { AxiError } from "axi-sdk-js";
import { annotateQuotaAdvice } from "./advice.js";
import { parseFlags, parseModelsFlags, type QuotaFlags } from "./args.js";
import { writeCachedProviders } from "./cache.js";
import { withQuotaSemantics } from "./interpretation.js";
import { createModelsResponse, MODEL_CATALOG_PROVIDER_IDS } from "./models.js";
import { nowIso } from "./lib/time.js";
import { PROVIDERS } from "./providers/index.js";
import {
  quotaJsonReport,
  redactedResponse,
  renderAuthToon,
  renderModelsToon,
  renderQuotaToon,
} from "./render.js";
import { formatInterval, runLiveTui, type LiveTuiIo } from "./tui-live.js";
import {
  detectTuiColorDepth,
  renderQuotaTui,
  renderTuiHintLine,
  type TuiColorDepth,
} from "./tui.js";
import { scrollHint } from "./tui-viewport.js";
import type {
  AuthProviderReport,
  LiveModelCatalog,
  ProviderId,
  ProviderOptions,
  ProviderQuota,
  QuotaAxiResponse,
} from "./types.js";

export type QuotaContext = {
  binPath: string;
};

const DEFAULT_REFRESH_SECONDS = 300;

export async function quotaCommand(
  args: string[],
  context: QuotaContext | undefined,
): Promise<string> {
  const binPath = context?.binPath ?? "quota-axi";
  const flags = parseFlags(args);
  const options: ProviderOptions = {
    allowKeychainPrompt: flags.allowKeychainPrompt,
    refreshCredentials: !flags.noCredentialRefresh,
  };

  if (flags.tui) return quotaTuiReport(flags, options);

  const response = await loadQuota(flags.providers, options, false);
  return flags.json
    ? JSON.stringify(quotaJsonReport(response, flags.full), null, 2)
    : renderQuotaToon(
        redactedResponse(response, flags.full),
        binPath,
        flags.full,
      );
}

/**
 * Render the human report. On an interactive terminal it stays live until the
 * operator quits and then echoes the final frame onto the normal screen;
 * everywhere else (pipes, CI, `--once`) it renders a single frame.
 */
async function quotaTuiReport(
  flags: QuotaFlags,
  options: ProviderOptions,
): Promise<string> {
  const terminal = (): { columns?: number; colorDepth: TuiColorDepth } => ({
    ...(process.stdout.columns === undefined
      ? {}
      : { columns: process.stdout.columns }),
    colorDepth: detectTuiColorDepth(process.env, process.stdout.isTTY === true),
  });
  const frame = (response: QuotaAxiResponse): string =>
    renderQuotaTui(redactedResponse(response, flags.full), {
      ...terminal(),
      full: flags.full,
    });

  if (flags.once || !isInteractiveTerminal()) {
    return frame(await loadQuota(flags.providers, options, false));
  }

  const refreshSeconds = flags.refreshSeconds ?? DEFAULT_REFRESH_SECONDS;
  const hint = `Press q to quit · refreshing every ${formatInterval(refreshSeconds)}`;
  const last = await runLiveTui<QuotaAxiResponse>({
    load: () => loadQuota(flags.providers, options, true),
    render: frame,
    status: (scroll) => renderTuiHintLine(scrollHint(scroll, hint), terminal()),
    intervalMillis: refreshSeconds * 1000,
    io: processLiveTuiIo(),
  });
  return last === undefined ? "" : frame(last);
}

function isInteractiveTerminal(): boolean {
  return process.stdout.isTTY === true && process.stdin.isTTY === true;
}

function processLiveTuiIo(): LiveTuiIo {
  return {
    stdout: process.stdout,
    stdin: process.stdin,
    rows: () => process.stdout.rows,
    columns: () => process.stdout.columns,
    setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
    clearTimer: (handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    onResize: (listener) => {
      process.stdout.on("resize", listener);
      return () => {
        process.stdout.off("resize", listener);
      };
    },
    onSignal: (listener) => {
      const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
      for (const signal of signals) process.on(signal, listener);
      return () => {
        for (const signal of signals) process.off(signal, listener);
      };
    },
  };
}

/**
 * Fetch, apply the all-failed exit code, and refresh the cache. A live report
 * re-evaluates the exit code every cycle so quitting reflects the last frame.
 */
async function loadQuota(
  providers: ProviderId[],
  options: ProviderOptions,
  live: boolean,
): Promise<QuotaAxiResponse> {
  const response = await fetchQuota(providers, options);
  const allFailed = response.providers.every(isFailed);
  if (allFailed) process.exitCode = 1;
  else if (live) process.exitCode = undefined;
  writeCachedProvidersBestEffort(response.providers);
  return response;
}

export async function modelsCommand(
  args: string[],
  context: QuotaContext | undefined,
): Promise<string> {
  const binPath = context?.binPath ?? "quota-axi";
  const flags = parseModelsFlags(args);
  const options: ProviderOptions = {
    allowKeychainPrompt: flags.allowKeychainPrompt,
    refreshCredentials: !flags.noCredentialRefresh,
  };
  // Sequenced, not parallel: the quota read owns credential refresh and the
  // one-time Keychain grant, so the catalog read must observe the store it
  // leaves behind instead of racing it with a pre-refresh token.
  const quota = await fetchQuota(flags.providers, options);
  const liveCatalogs = await fetchLiveModelCatalogs(flags.providers, options);
  writeCachedProvidersBestEffort(quota.providers);
  const response = createModelsResponse(quota, {
    liveCatalogs,
    ...(flags.intelligence ? { intelligence: flags.intelligence } : {}),
    ...(flags.sort ? { sort: flags.sort } : {}),
  });

  const modelProviders = quota.providers.filter((provider) =>
    MODEL_CATALOG_PROVIDER_IDS.includes(provider.provider),
  );
  if (modelProviders.every(isFailed)) process.exitCode = 1;
  return flags.json
    ? JSON.stringify(response, null, 2)
    : renderModelsToon(response, binPath, flags.full);
}

export async function authCommand(
  args: string[],
  context: QuotaContext | undefined,
): Promise<string> {
  const binPath = context?.binPath ?? "quota-axi";
  const flags = parseFlags(args);
  if (flags.tui) {
    throw new AxiError(
      "--tui is only supported by the quota command",
      "VALIDATION_ERROR",
      ["Run `quota-axi --tui` for the human quota report"],
    );
  }
  // `auth` reports the credential state that is on disk right now, so it never
  // delegates a refresh even when the quota path would.
  const options: ProviderOptions = {
    allowKeychainPrompt: flags.allowKeychainPrompt,
    refreshCredentials: false,
  };

  const reports = await inspectAuth(flags.providers, options);
  return flags.json
    ? JSON.stringify(
        { generatedAt: nowIso(), schemaVersion: 1, auth: reports },
        null,
        2,
      )
    : renderAuthToon(reports, binPath);
}

export async function fetchQuota(
  providers: ProviderId[],
  options: ProviderOptions,
): Promise<QuotaAxiResponse> {
  const generatedAt = nowIso();
  const results = (
    await Promise.all(
      providers.map((provider) => PROVIDERS[provider].fetchQuota(options)),
    )
  ).map((provider) => withQuotaSemantics(provider, generatedAt));
  return annotateQuotaAdvice({
    generatedAt,
    providers: results,
  });
}

/**
 * Read each provider's own live model lineup. A provider with no verified
 * first-party listing endpoint, or one that fails, resolves as `unavailable`
 * with a reason so the join can disclose it instead of silently answering from
 * the built-in catalog.
 */
export async function fetchLiveModelCatalogs(
  providers: ProviderId[],
  options: ProviderOptions,
): Promise<LiveModelCatalog[]> {
  return Promise.all(
    providers.map(async (provider) => {
      const adapter = PROVIDERS[provider];
      if (!adapter.fetchModelCatalog) {
        return {
          provider,
          status: "unavailable" as const,
          reason: "no_live_catalog_source",
        };
      }
      try {
        return await adapter.fetchModelCatalog(options);
      } catch {
        return {
          provider,
          status: "unavailable" as const,
          reason: "catalog_unreachable",
        };
      }
    }),
  );
}

async function inspectAuth(
  providers: ProviderId[],
  options: ProviderOptions,
): Promise<AuthProviderReport[]> {
  return Promise.all(
    providers.map((provider) => PROVIDERS[provider].inspectAuth(options)),
  );
}

function isFailed(provider: ProviderQuota): boolean {
  return !["fresh", "stale"].includes(provider.state.status);
}

function writeCachedProvidersBestEffort(providers: ProviderQuota[]): void {
  try {
    writeCachedProviders(providers);
  } catch {
    return;
  }
}

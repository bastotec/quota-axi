import {
  intelligenceForLiveModel,
  liveModelMatchesWindowSlug,
  modelWindowSlug,
} from "./model-catalog.js";
import { MODEL_CATALOG } from "./model-kb.js";
import type {
  EffectiveAvailability,
  IntelligenceBucket,
  LiveModelCatalog,
  LiveModelRecord,
  ModelCatalog,
  ModelCatalogEntry,
  ModelCatalogSourceReport,
  ModelQuotaRecord,
  ModelReference,
  ModelSortKey,
  ModelsResponse,
  ProviderId,
  ProviderQuota,
  ProviderStateSummary,
  QuotaAxiResponse,
} from "./types.js";

const INTELLIGENCE_BUCKETS = new Set<IntelligenceBucket>([
  "high",
  "medium",
  "low",
]);
export const MODEL_CATALOG_PROVIDER_IDS: readonly ProviderId[] = [
  ...new Set(MODEL_CATALOG.entries.map((entry) => entry.provider)),
];
const MODEL_KB_PROVIDERS = new Set<ProviderId>(MODEL_CATALOG_PROVIDER_IDS);

export const MODEL_SORT_KEYS = [
  "runway",
] as const satisfies readonly ModelSortKey[];

export type ModelComparator = {
  compare: (left: ModelQuotaRecord, right: ModelQuotaRecord) => number;
  tieKey: (model: ModelQuotaRecord) => string;
};

/**
 * Registry for explicit, evidence-only ordering. New comparators (such as a
 * future cost comparator) belong here with their data dependency and docs.
 */
export const MODEL_COMPARATORS: Readonly<
  Record<ModelSortKey, ModelComparator>
> = {
  runway: {
    compare: compareModelsByRunway,
    tieKey: runwayTieKey,
  },
};

validateModelCatalog(MODEL_CATALOG);

/**
 * Join the providers' own live model lineups with local quota evidence.
 *
 * Model identity is the vendor's: rows for a provider whose live catalog was
 * read name only models that provider listed on this run, and a model-scoped
 * window is attributed by matching the vendor's window slug against the
 * vendor's model identity. The built-in catalog contributes reviewed
 * intelligence buckets and nothing else.
 *
 * When a provider's live catalog cannot be read, its rows fall back to the
 * built-in lineup but are marked `unverified_builtin` and the provider is named
 * in `catalogSources` and `unverifiedIdentityProviders`, so no reader can
 * mistake quota-axi's own stale lineup for the vendor's current one.
 */
export function createModelsResponse(
  quota: QuotaAxiResponse,
  options: {
    intelligence?: IntelligenceBucket;
    sort?: ModelSortKey;
    catalog?: ModelCatalog;
    liveCatalogs?: readonly LiveModelCatalog[];
  } = {},
): ModelsResponse {
  const catalog = options.catalog ?? MODEL_CATALOG;
  validateModelCatalog(catalog);
  const catalogProviders = new Set(
    catalog.entries.map((entry) => entry.provider),
  );
  const providers = quota.providers.filter((provider) =>
    catalogProviders.has(provider.provider as ModelCatalogEntry["provider"]),
  );
  const liveByProvider = new Map(
    (options.liveCatalogs ?? []).map((live) => [live.provider, live]),
  );

  const rows: ModelQuotaRecord[] = [];
  const catalogSources: ModelCatalogSourceReport[] = [];
  const unverifiedIdentityProviders: ProviderId[] = [];
  const unmatchedWindowIds: string[] = [];

  for (const provider of providers) {
    const live = liveByProvider.get(provider.provider) ?? {
      provider: provider.provider,
      status: "unavailable" as const,
      reason: "no_live_catalog_source",
    };
    catalogSources.push(catalogSourceReport(live));

    if (live.status === "live") {
      rows.push(...liveRows(live.models, provider, catalog.entries));
      unmatchedWindowIds.push(...unmatchedAgainstLive(provider, live.models));
      continue;
    }

    unverifiedIdentityProviders.push(provider.provider);
    rows.push(...builtinRows(provider, catalog.entries));
    unmatchedWindowIds.push(
      ...unmatchedAgainstBuiltin(provider, catalog.entries),
    );
  }

  const models = rows
    .filter(
      (model) =>
        options.intelligence === undefined ||
        model.intelligence === options.intelligence,
    )
    .sort(compareModelIdentity);

  const base = {
    generatedAt: quota.generatedAt,
    schemaVersion: 2 as const,
    intelligenceCatalog: catalogSummary(catalog),
    catalogSources,
  };
  const disclosure = {
    ...(unmatchedWindowIds.length > 0 ? { unmatchedWindowIds } : {}),
    ...(unverifiedIdentityProviders.length > 0
      ? { unverifiedIdentityProviders }
      : {}),
  };

  if (!options.sort) return { ...base, models, ...disclosure };

  const comparator = MODEL_COMPARATORS[options.sort];
  const sorted = [...models].sort(
    (left, right) =>
      comparator.compare(left, right) || compareModelIdentity(left, right),
  );
  return {
    ...base,
    models: sorted,
    ...disclosure,
    sort: {
      key: options.sort,
      tieGroups: tieGroups(sorted, comparator),
    },
  };
}

/**
 * Sort by observable usable runway only. It does not assess model capability,
 * task fit, credentials, prices, or a route. Unknown evidence remains last.
 */
export function compareModelsByRunway(
  left: ModelQuotaRecord,
  right: ModelQuotaRecord,
): number {
  const leftRank = runwayRank(left);
  const rightRank = runwayRank(right);
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (leftRank !== 0) return 0;
  return (
    (right.effective?.runway?.usableRunwaySeconds ?? 0) -
    (left.effective?.runway?.usableRunwaySeconds ?? 0)
  );
}

export function validateModelCatalog(catalog: ModelCatalog): void {
  const versionTimestamp = Date.parse(`${catalog.version}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(catalog.version) ||
    Number.isNaN(versionTimestamp) ||
    new Date(versionTimestamp).toISOString().slice(0, 10) !== catalog.version
  ) {
    throw new Error("model catalog version must be an ISO calendar date");
  }
  if (!catalog.provenance.trim())
    throw new Error("model catalog provenance is required");

  const seen = new Set<string>();
  for (const entry of catalog.entries) {
    if (!MODEL_KB_PROVIDERS.has(entry.provider)) {
      throw new Error(
        `model catalog provider is unsupported: ${entry.provider}`,
      );
    }
    if (!entry.id.trim() || !entry.label.trim()) {
      throw new Error("model catalog entries require id and label");
    }
    if (!INTELLIGENCE_BUCKETS.has(entry.intelligence)) {
      throw new Error(
        `model catalog intelligence is invalid: ${entry.intelligence}`,
      );
    }
    const key = `${entry.provider}/${entry.id}`;
    if (seen.has(key)) throw new Error(`duplicate model catalog entry: ${key}`);
    seen.add(key);
    for (const windowId of entry.windowIds ?? []) {
      if (!/^model:[a-z0-9][a-z0-9_.:-]*$/i.test(windowId)) {
        throw new Error(`model catalog window id is invalid: ${windowId}`);
      }
    }
  }
}

function catalogSourceReport(live: LiveModelCatalog): ModelCatalogSourceReport {
  return live.status === "live"
    ? {
        provider: live.provider,
        status: "live",
        fetchedAt: live.fetchedAt,
        modelCount: live.models.length,
      }
    : { provider: live.provider, status: "unavailable", reason: live.reason };
}

/** One row per model the vendor itself listed on this run. */
function liveRows(
  live: readonly LiveModelRecord[],
  provider: ProviderQuota,
  entries: readonly ModelCatalogEntry[],
): ModelQuotaRecord[] {
  const state = stateSummary(provider);
  return live.map((model) => {
    const effective = liveAvailabilityFor(model, provider);
    const intelligence = intelligenceForLiveModel(model, entries);
    return {
      provider: provider.provider as ModelCatalogEntry["provider"],
      id: model.id,
      label: model.label,
      identitySource: "live_catalog" as const,
      ...(intelligence ? { intelligence } : {}),
      quotaScopes: effective ? [effective.scope] : [],
      ...(effective ? { effective } : {}),
      state,
    };
  });
}

/**
 * Rows restating quota-axi's own built-in lineup because the vendor's could not
 * be read. Every row is marked so it is never read as the vendor's answer.
 */
function builtinRows(
  provider: ProviderQuota,
  entries: readonly ModelCatalogEntry[],
): ModelQuotaRecord[] {
  const state = stateSummary(provider);
  return entries
    .filter((entry) => entry.provider === provider.provider)
    .map((entry) => {
      const effective = builtinAvailabilityFor(entry, provider);
      return {
        provider: entry.provider,
        id: entry.id,
        label: entry.label,
        identitySource: "unverified_builtin" as const,
        intelligence: entry.intelligence,
        quotaScopes: effective ? [effective.scope] : [],
        ...(effective ? { effective } : {}),
        state,
      };
    });
}

function liveAvailabilityFor(
  model: LiveModelRecord,
  provider: ProviderQuota,
): EffectiveAvailability | undefined {
  const availability = provider.quotaSemantics?.effectiveAvailability ?? [];
  const scoped = availability.find((candidate) =>
    liveModelMatchesWindowSlug(
      model,
      modelWindowSlug(normalizedModelScope(candidate.scope)),
    ),
  );
  return scoped ?? accountAvailability(availability);
}

function builtinAvailabilityFor(
  entry: ModelCatalogEntry,
  provider: ProviderQuota,
): EffectiveAvailability | undefined {
  const availability = provider.quotaSemantics?.effectiveAvailability ?? [];
  for (const windowId of entry.windowIds ?? []) {
    const found = availability.find(
      (candidate) => candidate.scope === normalizedModelScope(windowId),
    );
    if (found) return found;
  }
  return accountAvailability(availability);
}

function accountAvailability(
  availability: readonly EffectiveAvailability[],
): EffectiveAvailability | undefined {
  return availability.find(
    (candidate) =>
      candidate.scope === "all_models" || candidate.scope === "all_products",
  );
}

/** Model windows the vendor's own live lineup does not account for. */
function unmatchedAgainstLive(
  provider: ProviderQuota,
  live: readonly LiveModelRecord[],
): string[] {
  return modelScopes(provider)
    .filter(
      (scope) =>
        !live.some((model) =>
          liveModelMatchesWindowSlug(model, modelWindowSlug(scope)),
        ),
    )
    .map((scope) => `${provider.provider}/${scope}`);
}

function unmatchedAgainstBuiltin(
  provider: ProviderQuota,
  entries: readonly ModelCatalogEntry[],
): string[] {
  const knownScopes = new Set(
    entries
      .filter((entry) => entry.provider === provider.provider)
      .flatMap((entry) => entry.windowIds ?? [])
      .map(normalizedModelScope),
  );
  return modelScopes(provider)
    .filter((scope) => !knownScopes.has(scope))
    .map((scope) => `${provider.provider}/${scope}`);
}

function modelScopes(provider: ProviderQuota): string[] {
  const seen = new Set<string>();
  return provider.windows
    .filter((window) => window.kind === "model")
    .map((window) => normalizedModelScope(window.id))
    .filter((scope) => {
      if (seen.has(scope)) return false;
      seen.add(scope);
      return true;
    });
}

function normalizedModelScope(windowId: string): string {
  return windowId.replace(/_\d+$/, "").replace(/:(?:5h|7d|window:[^:]+)$/, "");
}

function stateSummary(provider: ProviderQuota): ProviderStateSummary {
  const { status, stale, authStatus, reason, remedyCommand } = provider.state;
  return {
    status,
    stale,
    ...(authStatus ? { authStatus } : {}),
    ...(reason ? { reason } : {}),
    ...(remedyCommand ? { remedyCommand } : {}),
  };
}

function catalogSummary(catalog: ModelCatalog) {
  return { version: catalog.version, provenance: catalog.provenance };
}

function compareModelIdentity(
  left: ModelReference,
  right: ModelReference,
): number {
  return (
    left.provider.localeCompare(right.provider) ||
    left.id.localeCompare(right.id)
  );
}

function runwayRank(model: ModelQuotaRecord): number {
  const runway = model.effective?.runway;
  if (
    runway?.status === "projected_exhaustion" &&
    runway.usableRunwaySeconds !== undefined
  )
    return 0;
  if (runway?.status === "through_reset") return 1;
  if (runway?.status === "exhausted_now") return 2;
  return 3;
}

function runwayTieKey(model: ModelQuotaRecord): string {
  const rank = runwayRank(model);
  return rank === 0
    ? `finite:${model.effective?.runway?.usableRunwaySeconds}`
    : ["through_reset", "exhausted_now", "unknown"][rank - 1]!;
}

function tieGroups(
  models: ModelQuotaRecord[],
  comparator: ModelComparator,
): ModelReference[][] {
  const groups: ModelReference[][] = [];
  for (let index = 0; index < models.length; ) {
    const key = comparator.tieKey(models[index]!);
    const group: ModelReference[] = [];
    while (index < models.length && comparator.tieKey(models[index]!) === key) {
      const model = models[index++]!;
      group.push({ provider: model.provider, id: model.id });
    }
    if (group.length > 1) groups.push(group);
  }
  return groups;
}

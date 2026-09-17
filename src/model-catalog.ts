import type {
  IntelligenceBucket,
  LiveModelRecord,
  ModelCatalogEntry,
} from "./types.js";

/**
 * Matching between a vendor's own quota-window scope and a vendor's own live
 * model record. Both sides are the provider's words, so nothing here asserts a
 * relationship quota-axi invented: a window is attributed to a model only when
 * the vendor's window slug is spelled inside the vendor's model identity.
 */

/**
 * The vendor's scope slug inside a model-scoped window id.
 * `model:fable` -> `fable`. A non-model scope yields an empty slug.
 */
export function modelWindowSlug(scope: string): string {
  return scope.startsWith("model:") ? scope.slice("model:".length) : "";
}

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Whether the vendor's live model record is in the scope its window slug names.
 *
 * The slug is a vendor scope name (`fable`, `gpt-5.1-codex`), which can cover a
 * family rather than one id, so every slug token must appear as a whole token
 * of the model's own id or display name. That keeps `fable` on the Fable models
 * and off every model whose name simply contains those letters.
 */
export function liveModelMatchesWindowSlug(
  model: LiveModelRecord,
  slug: string,
): boolean {
  const wanted = tokens(slug);
  if (wanted.length === 0) return false;
  const identity = new Set([...tokens(model.id), ...tokens(model.label)]);
  return wanted.every((token) => identity.has(token));
}

/**
 * The reviewed intelligence bucket for a live model, or undefined when no entry
 * covers it. Entries are matched on the vendor's identity only - exact id, a
 * declared alias, or the same id carrying a vendor date suffix
 * (`claude-sonnet-4-5` covers `claude-sonnet-4-5-20250929`). A model the
 * catalog has never reviewed stays unknown instead of inheriting a bucket.
 */
export function intelligenceForLiveModel(
  model: LiveModelRecord,
  entries: readonly ModelCatalogEntry[],
): IntelligenceBucket | undefined {
  return entries.find((entry) => coversLiveModel(entry, model))?.intelligence;
}

function coversLiveModel(
  entry: ModelCatalogEntry,
  model: LiveModelRecord,
): boolean {
  const names = [entry.id, ...(entry.aliases ?? [])];
  return names.some((name) => {
    const candidate = name.toLowerCase();
    const id = model.id.toLowerCase();
    if (candidate === id || candidate === model.label.toLowerCase())
      return true;
    // A dated vendor snapshot of the same model, never a different model.
    return (
      id.startsWith(`${candidate}-`) &&
      /^\d{8}$/.test(id.slice(candidate.length + 1))
    );
  });
}

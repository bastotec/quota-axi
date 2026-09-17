import type {
  IntelligenceBucket,
  LiveModelRecord,
  ModelCatalogEntry,
  ModelWindowScope,
} from "./types.js";

/**
 * Matching between a vendor's own quota-window scope and a vendor's own live
 * model record. Both sides are the provider's words, so nothing here asserts a
 * relationship quota-axi invented: a window is attributed to a model only when
 * what the vendor said about the window's scope is spelled inside the vendor's
 * own model identity.
 *
 * The scope arrives as the typed {@link ModelWindowScope} its adapter read, not
 * as a window id this module takes apart. Window ids are provider grammar and
 * are never parsed here.
 */

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Whether the vendor's live model record is inside the vendor's own window
 * scope.
 *
 * When the vendor named a model id, the scope points at exactly one model, so
 * it is attributed only on exact vendor identity - that id or the model's
 * display name, or that identity plus a dated vendor snapshot suffix. A version
 * is never allowed to reach a different version: a scope named for
 * `claude-opus-4` stays off `claude-opus-4-5-20251101`.
 *
 * When the vendor named no model id, all quota-axi has is the vendor's name for
 * the scope, which may name a model or a whole family. A name that carries a
 * version component names that version and is matched exactly; a name that
 * carries none names a family (Anthropic sends `scope.model.id: null` with
 * `display_name: "Fable"`, and meters an Opus-scoped week), so it is attributed
 * to every live model of that family - the honest one-to-many mapping, matched
 * on whole tokens so `fable` stays off every model that merely contains those
 * letters.
 */
export function liveModelMatchesScope(
  model: LiveModelRecord,
  scope: ModelWindowScope,
): boolean {
  if (scope.modelId) return namesModelExactly(model, scope.modelId);
  if (!scope.name) return false;
  return (
    namesModelExactly(model, scope.name) || namesFamilyOf(model, scope.name)
  );
}

/** The vendor name is this model's own identity, or a dated snapshot of it. */
function namesModelExactly(model: LiveModelRecord, name: string): boolean {
  const wanted = tokens(name);
  if (wanted.length === 0) return false;
  const id = tokens(model.id);
  if (sameTokens(wanted, id) || sameTokens(wanted, tokens(model.label)))
    return true;
  // A dated vendor snapshot of exactly the named model, never a sibling.
  return (
    id.length === wanted.length + 1 &&
    /^\d{8}$/.test(id[id.length - 1]!) &&
    sameTokens(wanted, id.slice(0, -1))
  );
}

/**
 * The vendor name carries no version component, so it names a family rather
 * than one release, and this model's identity spells every one of its tokens.
 */
function namesFamilyOf(model: LiveModelRecord, name: string): boolean {
  const wanted = tokens(name);
  if (wanted.length === 0) return false;
  if (wanted.some((token) => /\d/.test(token))) return false;
  const identity = new Set([...tokens(model.id), ...tokens(model.label)]);
  return wanted.every((token) => identity.has(token));
}

function sameTokens(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((token, index) => token === right[index])
  );
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

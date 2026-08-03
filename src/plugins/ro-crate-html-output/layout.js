// Merges a MASP profile's crate-o-mode.json propertyGroups into the generic
// DEFAULT_LAYOUT used to group properties in the HTML preview, so the
// preview reflects what the selected profile actually declares instead of
// always showing the same six generic categories.
import { DEFAULT_LAYOUT } from "../../default_layout.js";

// Resolves one group's short property names (e.g. "inLanguage", "portalName")
// to full URIs against the built crate's own context — the same context
// collectDescribeValues() wrote the actual properties under, so the
// resolved URI is guaranteed to match what's really on the entity.
// crate.resolveTerm() only resolves terms it can actually find in the
// context (confirmed by testing): real schema.org terms resolve directly,
// but this app's own invented fields (portalName/portalDescription) only
// resolve via a "custom:" prefix, matching how collectDescribeValues()
// writes them. An input that still doesn't resolve either way is dropped
// rather than guessed at.
export function resolveProfileGroups(crate, propertyGroups) {
  if (!Array.isArray(propertyGroups)) return [];
  return propertyGroups
    .map((group) => {
      const inputs = (group.inputs || [])
        .map((name) => crate.resolveTerm(name) || crate.resolveTerm(`custom:${name}`))
        .filter(Boolean);
      return { name: group.name, inputs };
    })
    .filter((group) => group.inputs.length > 0);
}

// Profile groups first (so they're the prominent tabs), then DEFAULT_LAYOUT's
// groups with any now-duplicated inputs filtered out (avoids showing the
// same property under two tabs). A DEFAULT_LAYOUT group whose *name* matches
// a profile group (e.g. both called "About") is folded into that profile
// group — its leftover inputs (the generic fields the profile didn't
// declare, like @id/@type) are appended after the profile's own — rather
// than producing two separately-labeled tabs with the same name. Any
// DEFAULT_LAYOUT group left with nothing to show is dropped entirely.
// Returns DEFAULT_LAYOUT unchanged if propertyGroups is absent/empty (no
// profile selected, or the profile declares none).
export function buildProfileAwareLayout(crate, propertyGroups) {
  const resolvedProfileGroups = resolveProfileGroups(crate, propertyGroups);
  if (!resolvedProfileGroups.length) return DEFAULT_LAYOUT;

  const coveredUris = new Set(resolvedProfileGroups.flatMap((g) => g.inputs));
  const merged = resolvedProfileGroups.map((g) => ({ ...g, inputs: [...g.inputs] }));
  const mergedByName = new Map(merged.map((g) => [g.name, g]));
  const trailing = [];

  for (const group of DEFAULT_LAYOUT) {
    const remainingInputs = group.inputs.filter((uri) => !coveredUris.has(uri));
    if (!remainingInputs.length) continue;
    const existing = mergedByName.get(group.name);
    if (existing) existing.inputs.push(...remainingInputs);
    else trailing.push({ ...group, inputs: remainingInputs });
  }

  return [...merged, ...trailing];
}

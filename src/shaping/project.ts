/**
 * Field projection — the cheap 95% of response shaping.
 *
 * Coolify's list endpoints return the full Eloquent model plus its `settings`
 * relation: roughly 80 columns per application, none of which the caller asked
 * for. Everything in envelope.ts is the fallback for when projection alone is
 * not enough; this module is what makes that fallback rare.
 */

/** A JSON object as it comes off the Coolify API. */
export type Row = Record<string, unknown>;

/**
 * Keep only `fields`, in the order given.
 *
 * This is an allowlist by design. A denylist would start leaking every column a
 * future Coolify release adds, so the budget would regress on someone else's
 * release schedule with no change on our side. An allowlist can only ever be
 * smaller than the upstream payload.
 *
 * The list belongs in the calling tool's own module, not in a shared constants
 * file — co-locating it with the tool is what keeps it maintained when the tool
 * changes.
 */
export function project(rows: readonly Row[], fields: readonly string[]): Row[] {
  return rows.map((row) => projectOne(row, fields));
}

/** Single-object form, for the `get_*` tools that return one record. */
export function projectOne(row: Row, fields: readonly string[]): Row {
  const out: Row = {};
  for (const field of fields) {
    const value = row[field];
    // Absent stays absent. Emitting `"field": null` for a column this Coolify
    // version does not have reads to a model as "the value is null", which is a
    // different and wrong claim.
    if (value === undefined) continue;
    out[field] = value;
  }
  return out;
}

/**
 * Drop `prunable` fields.
 *
 * The degradation ladder calls this with progressively longer prefixes of the
 * tool's prunable list, so the order a tool declares is the order in which its
 * columns are sacrificed under budget pressure.
 */
export function prune(rows: readonly Row[], prunable: readonly string[]): Row[] {
  const drop = new Set(prunable);
  return rows.map((row) => pruneRow(row, drop));
}

/** Single-object form of {@link prune}. */
export function pruneOne(row: Row, prunable: readonly string[]): Row {
  return pruneRow(row, new Set(prunable));
}

/** Builds a copy rather than deleting keys: callers hand us live response objects. */
function pruneRow(row: Row, drop: ReadonlySet<string>): Row {
  const out: Row = {};
  for (const key of Object.keys(row)) {
    if (drop.has(key)) continue;
    out[key] = row[key];
  }
  return out;
}

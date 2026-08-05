function camelizeKey(key) {
  return String(key).replace(/_([a-z0-9])/g, (_, ch) => ch.toUpperCase());
}

function normalizeObject(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeObject);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[camelizeKey(k)] = normalizeObject(v);
    }
    return out;
  }
  return value;
}

export function normalizeComparePayload(payload) {
  const normalized = normalizeObject(payload || {});
  const progress = normalized.progress || {};
  const progressOut = {
    total: progress.total ?? progress.totalCount ?? 0,
    processed: progress.processed ?? 0,
    foundCount: progress.foundCount ?? progress.found_count ?? 0,
    notFoundCount: progress.notFoundCount ?? progress.not_found_count ?? 0,
  };
  if (Object.prototype.hasOwnProperty.call(progress, 'sefariaUpdate') || Object.prototype.hasOwnProperty.call(progress, 'sefaria_update')) {
    progressOut.sefariaUpdate = !!(progress.sefariaUpdate ?? progress.sefaria_update);
  }
  return {
    ...normalized,
    jobId: normalized.jobId ?? normalized.job_id ?? null,
    idx: normalized.idx ?? null,
    result: normalized.result ?? null,
    progress: progressOut,
  };
}

export function normalizeSummary(summary) {
  const normalized = normalizeObject(summary || {});
  return {
    totalRefs: normalized.totalRefs ?? normalized.total_refs ?? 0,
    foundCount: normalized.foundCount ?? normalized.found_count ?? 0,
    notFoundCount: normalized.notFoundCount ?? normalized.not_found_count ?? 0,
    sefariaFoundCount: normalized.sefariaFoundCount ?? normalized.sefaria_found_count ?? 0,
    aborted: !!normalized.aborted,
    error: normalized.error ?? null,
  };
}

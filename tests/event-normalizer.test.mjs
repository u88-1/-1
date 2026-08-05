import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeComparePayload, normalizeSummary } from '../src/event-normalizer.js';

test('normalizes camelCase event payloads', () => {
  const payload = {
    jobId: 'job-1',
    idx: 3,
    result: { ref: 'בבא קמא' },
    progress: { total: 10, processed: 4, foundCount: 2, notFoundCount: 8 },
  };

  assert.deepEqual(normalizeComparePayload(payload), {
    jobId: 'job-1',
    idx: 3,
    result: { ref: 'בבא קמא' },
    progress: { total: 10, processed: 4, foundCount: 2, notFoundCount: 8 },
  });
});

test('normalizes snake_case event payloads from Rust', () => {
  const payload = {
    job_id: 'job-2',
    idx: 7,
    result: { ref: 'שבת' },
    progress: { total: 12, processed: 9, found_count: 5, not_found_count: 7 },
  };

  assert.deepEqual(normalizeComparePayload(payload), {
    jobId: 'job-2',
    idx: 7,
    result: { ref: 'שבת' },
    progress: { total: 12, processed: 9, foundCount: 5, notFoundCount: 7 },
  });
});

test('normalizes summary fields from snake_case', () => {
  const summary = {
    total_refs: 20,
    found_count: 15,
    not_found_count: 5,
    sefaria_found_count: 3,
    aborted: false,
    error: null,
  };

  assert.deepEqual(normalizeSummary(summary), {
    totalRefs: 20,
    foundCount: 15,
    notFoundCount: 5,
    sefariaFoundCount: 3,
    aborted: false,
    error: null,
  });
});

import { describe, expect, it } from 'vitest';
import { collageEvent } from '../src/collage-events.js';

describe('navigation diagnostic contract', () => {
  const base = { type: 'viewer.collage', id: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222', buildId: 'test',
    at: '2026-10-01T00:00:00Z', sequence: 1 };
  it('accepts bounded navigation timings and reserve lifecycle', () => {
    for (const action of ['input-classified', 'navigation-requested', 'navigation-ignored',
      'navigation-visible', 'reserve-ready', 'reserve-used', 'preload-joined', 'navigation-joined',
      'navigation-deferred', 'navigation-deferred-used', 'navigation-deferred-cleared',
      'scene-budget-started', 'scene-budget-adjusted', 'scene-budget-suspension', 'scene-budget-expired']) {
      expect(collageEvent({ ...base, action, details: { direction: -1, elapsedMs: 150,
        source: 'manual', reason: 'manual', operationId: 2, budgetMs: 83914, mediaIds: ['test'] } })).not.toBeNull();
    }
  });
  it('rejects private coordinates, URLs and malformed timings', () => {
    for (const details of [{ x: 45 }, { url: '/private' }, { elapsedMs: Infinity }, { source: 'unknown' }]) {
      expect(collageEvent({ ...base, action: 'navigation-visible', details })).toBeNull();
    }
  });
});

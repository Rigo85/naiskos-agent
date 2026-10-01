const ACTIONS = new Set(['checkpoint-restored', 'checkpoint-rejected', 'checkpoint-write-failed',
  'round-reconciled', 'manual-selection', 'history-selected', 'history-committed', 'renewal-deferred',
  'boundary-repeat-unavoidable', 'round-adopted', 'scene-committed', 'plan-requested', 'plan-ready',
  'lookahead-ready', 'plan-failed', 'refinement-fallback', 'plan-cancelled', 'planning-suspended',
  'planning-resumed', 'media-failed', 'preload-ready', 'preload-failed', 'preload-cancelled', 'preload-used',
  'preload-joined', 'reserve-ready', 'reserve-used', 'input-classified',
  'navigation-requested', 'navigation-ignored', 'navigation-visible', 'navigation-joined',
  'navigation-deferred', 'navigation-deferred-used', 'navigation-deferred-cleared']);
const FIELDS = new Set(['round','seed','basis','manifestVersion','restoredRound','restoredSeen',
  'materials','cohort','seen','scenes','mediaIds','historyIndex','reason','previousRound','fallback',
  'sceneIndex','nextRound','nextSeed','elapsedMs','attempt','deliveryOverflow','operationId','planningGeneration','direction','source']);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function collageEvent(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const e = input as Record<string, unknown>;
  if (e.type !== 'viewer.collage' || !UUID.test(String(e.id)) || !UUID.test(String(e.sessionId)) ||
    typeof e.buildId !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(e.buildId) ||
    typeof e.at !== 'string' || e.at.length > 32 || !Number.isFinite(Date.parse(e.at)) ||
    !Number.isSafeInteger(e.sequence) || Number(e.sequence) < 1 || !ACTIONS.has(String(e.action)) ||
    !e.details || typeof e.details !== 'object' || Array.isArray(e.details)) return null;
  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(e.details)) {
    if (!FIELDS.has(key)) return null;
    if (key === 'source' && !['manual', 'gallery', 'automatic', 'system'].includes(String(value))) return null;
    if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ||
      typeof value === 'boolean' || typeof value === 'string' && /^[a-zA-Z0-9:._ -]{0,160}$/.test(value) ||
      key === 'mediaIds' && Array.isArray(value) && value.length <= 4 &&
      value.every((id) => typeof id === 'string' && /^[a-zA-Z0-9._-]{1,128}$/.test(id))) details[key] = value;
    else return null;
  }
  return { type: e.type, id: e.id, sessionId: e.sessionId, buildId: e.buildId,
    at: e.at, sequence: e.sequence, action: e.action, details };
}

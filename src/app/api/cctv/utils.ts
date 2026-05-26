import type { CctvCamera } from './types';

export interface SourceHealth {
  ok: boolean;
  count: number;
  latency_ms: number;
  last_success_iso?: string;
  error?: string;
}

export interface TimedFetchResult<T> {
  data: T;
  latencyMs: number;
}

export function normalizeCamera(raw: Partial<CctvCamera>, sourceOverride?: string): CctvCamera | null {
  const lat = typeof raw.lat === 'string' ? parseFloat(raw.lat) : raw.lat;
  const lng = typeof raw.lng === 'string' ? parseFloat(raw.lng) : raw.lng;
  const source = sourceOverride || raw.source;

  if (!source || !Number.isFinite(lat) || !Number.isFinite(lng) || !raw.id || !raw.name) {
    return null;
  }

  return {
    id: raw.id,
    lat: lat as number,
    lng: lng as number,
    name: raw.name,
    city: raw.city || 'Unknown',
    country: raw.country || 'UK',
    source,
    feed_url: raw.feed_url,
    stream_url: raw.stream_url,
    stream_type: raw.stream_type,
    external_url: raw.external_url,
  };
}

export function dedupeCameras(cameras: CctvCamera[]): CctvCamera[] {
  const seen = new Set<string>();
  const deduped: CctvCamera[] = [];

  for (const camera of cameras) {
    const geoKey = `${camera.source}:${camera.lat.toFixed(4)}:${camera.lng.toFixed(4)}`;
    const dedupeKey = camera.id ? `${camera.source}:${camera.id}` : geoKey;

    if (seen.has(dedupeKey) || seen.has(geoKey)) {
      continue;
    }

    seen.add(dedupeKey);
    seen.add(geoKey);
    deduped.push(camera);
  }

  return deduped;
}

export async function timedFetchJson<T>(url: string, timeoutMs: number, init?: RequestInit): Promise<TimedFetchResult<T>> {
  const startedAt = Date.now();
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return {
    data: await response.json() as T,
    latencyMs: Date.now() - startedAt,
  };
}

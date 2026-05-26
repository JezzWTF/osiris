import type { CctvCamera } from './types';
import { UK_CURATED_CAMERAS } from './uk-curated';
import { dedupeCameras, normalizeCamera, timedFetchJson, type SourceHealth } from './utils';

const UK_SOURCE_TIMEOUT_MS = 10000;
const NATIONAL_HIGHWAYS_BBOX = '-7.8,49.8,2.1,56.2';

type HealthMap = Record<string, SourceHealth>;

interface TflPlace {
  id?: string;
  commonName?: string;
  lat?: number;
  lon?: number;
  additionalProperties?: Array<{ key?: string; value?: string }>;
}

interface NationalHighwaysCamera {
  id?: number;
  description?: string;
  latitude?: number;
  longitude?: number;
  url?: string;
  available?: boolean;
}

interface TrafficNiCamera {
  id?: string;
  latitude?: number;
  longitude?: number;
  summary?: string;
  details?: {
    cctvImageUrl?: string;
  };
}

interface SourceResult {
  source: string;
  cameras: CctvCamera[];
  health: SourceHealth;
}

export async function fetchTfLCamerasUk(): Promise<CctvCamera[]> {
  const { data } = await timedFetchJson<TflPlace[]>(
    'https://api.tfl.gov.uk/Place/Type/JamCam',
    UK_SOURCE_TIMEOUT_MS,
  );

  return (data || [])
    .map((cam) => {
      const imgProp = cam.additionalProperties?.find((prop) => prop.key === 'imageUrl');
      const camId = cam.id?.replace('JamCams_', '') || '';
      return normalizeCamera({
        id: `tfl-${cam.id}`,
        lat: cam.lat,
        lng: cam.lon,
        name: cam.commonName || 'London JamCam',
        city: 'London',
        country: 'UK',
        feed_url: imgProp?.value || (camId ? `https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/${camId}.jpg` : undefined),
        source: 'TfL',
      });
    })
    .filter((camera): camera is CctvCamera => camera !== null);
}

export async function fetchNationalHighwaysCameras(): Promise<CctvCamera[]> {
  const { data } = await timedFetchJson<NationalHighwaysCamera[]>(
    `https://www.trafficengland.com/api/cctv/getToBounds?bbox=${NATIONAL_HIGHWAYS_BBOX}`,
    UK_SOURCE_TIMEOUT_MS,
    {
      headers: {
        Referer: 'https://www.trafficengland.com/',
      },
    },
  );

  return (data || [])
    .slice(0, 2000)
    .map((cam) => normalizeCamera({
      id: `nh-${cam.id}`,
      lat: cam.latitude,
      lng: cam.longitude,
      name: cam.description || 'National Highways Camera',
      city: 'England',
      country: 'UK',
      external_url: cam.url?.replace('http:', 'https:'),
      source: 'National Highways',
    }))
    .filter((camera): camera is CctvCamera => camera !== null);
}

export async function fetchTrafficScotlandCameras(): Promise<CctvCamera[]> {
  return [];
}

export async function fetchTrafficWalesCameras(): Promise<CctvCamera[]> {
  return [];
}

export async function fetchTrafficNICameras(): Promise<CctvCamera[]> {
  const pageUrl = 'https://www.trafficwatchni.com/twni/cameras?viewby=mapCheck&d=CCTV_CAMERAS';
  const pageResponse = await fetch(pageUrl, {
    signal: AbortSignal.timeout(UK_SOURCE_TIMEOUT_MS),
  });

  if (!pageResponse.ok) {
    throw new Error(`Trafficwatch NI page HTTP ${pageResponse.status}`);
  }

  const pageHtml = await pageResponse.text();
  const csrfToken = pageHtml.match(/<meta name="_csrf"\s+content="([^"]+)"/i)?.[1];
  const csrfHeader = pageHtml.match(/<meta name="_csrf_header"\s+content="([^"]+)"/i)?.[1];

  if (!csrfToken || !csrfHeader) {
    throw new Error('Trafficwatch NI CSRF tokens not found');
  }

  const mapResponse = await fetch('https://www.trafficwatchni.com/twni/map/mapData', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: pageUrl,
      [csrfHeader]: csrfToken,
    },
    body: 'selectedTypes=CCTV_CAMERAS',
    signal: AbortSignal.timeout(UK_SOURCE_TIMEOUT_MS),
  });

  if (!mapResponse.ok) {
    throw new Error(`Trafficwatch NI map HTTP ${mapResponse.status}`);
  }

  const payload = await mapResponse.json() as {
    mapData?: {
      CCTV_CAMERAS?: TrafficNiCamera[];
    };
  };

  return (payload.mapData?.CCTV_CAMERAS || [])
    .slice(0, 1000)
    .map((cam) => {
      const cameraId = cam.id?.trim();
      const popupPath = cam.details?.cctvImageUrl?.trim();
      const popupUrl = popupPath
        ? `https://www.trafficwatchni.com${popupPath.startsWith('/') ? popupPath : `/${popupPath}`}`
        : undefined;

      return normalizeCamera({
        id: `ni-${cameraId}`,
        lat: cam.latitude,
        lng: cam.longitude,
        name: cam.summary || 'Trafficwatch NI Camera',
        city: 'Northern Ireland',
        country: 'UK',
        stream_url: popupUrl,
        stream_type: popupUrl ? 'iframe' : undefined,
        external_url: cameraId
          ? `https://www.trafficwatchni.com/twni/cameras/static?id=${cameraId}`
          : undefined,
        source: 'Trafficwatch NI',
      });
    })
    .filter((camera): camera is CctvCamera => camera !== null);
}

export async function fetchUkCuratedCameras(): Promise<CctvCamera[]> {
  return UK_CURATED_CAMERAS;
}

async function runSource(source: string, fetcher: () => Promise<CctvCamera[]>, errorHint?: string): Promise<SourceResult> {
  const startedAt = Date.now();

  try {
    const cameras = dedupeCameras(await fetcher());
    const latencyMs = Date.now() - startedAt;

    return {
      source,
      cameras,
      health: {
        ok: cameras.length > 0 || !errorHint,
        count: cameras.length,
        latency_ms: latencyMs,
        last_success_iso: new Date().toISOString(),
        ...(cameras.length === 0 && errorHint ? { error: errorHint } : {}),
      },
    };
  } catch (error) {
    return {
      source,
      cameras: [],
      health: {
        ok: false,
        count: 0,
        latency_ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
    };
  }
}

function filterByContext(cameras: CctvCamera[], ctx?: { lat?: number; lng?: number; radius?: number }): CctvCamera[] {
  if (!ctx?.lat || !ctx?.lng || !ctx?.radius) {
    return cameras;
  }

  const { lat, lng, radius } = ctx;
  const latDelta = radius / 111;
  const lngDelta = radius / (111 * Math.max(Math.cos((lat * Math.PI) / 180), 0.1));

  return cameras.filter((camera) =>
    camera.lat >= lat - latDelta &&
    camera.lat <= lat + latDelta &&
    camera.lng >= lng - lngDelta &&
    camera.lng <= lng + lngDelta
  );
}

export async function fetchUkCameras(ctx?: {
  lat?: number;
  lng?: number;
  radius?: number;
}): Promise<{ cameras: CctvCamera[]; health: HealthMap }> {
  const sourceRuns = [
    runSource('TfL', fetchTfLCamerasUk),
    runSource('National Highways', fetchNationalHighwaysCameras),
    runSource('Traffic Scotland', fetchTrafficScotlandCameras, 'Requires developer registration'),
    runSource('Traffic Wales', fetchTrafficWalesCameras, 'one.network feed still under investigation'),
    runSource('Trafficwatch NI', fetchTrafficNICameras),
    runSource('UK Curated', fetchUkCuratedCameras),
  ];

  const results = await Promise.allSettled(sourceRuns);
  const health: HealthMap = {};
  const allCameras: CctvCamera[] = [];

  for (const result of results) {
    if (result.status !== 'fulfilled') {
      continue;
    }

    health[result.value.source] = result.value.health;
    allCameras.push(...result.value.cameras);
  }

  const cameras = filterByContext(dedupeCameras(allCameras), ctx);

  for (const source of Object.keys(health)) {
    if (source === 'UK Curated') {
      continue;
    }

    if (health[source].count === 0 && !health[source].error) {
      health[source].error = 'No cameras returned';
    }
  }

  return { cameras, health };
}

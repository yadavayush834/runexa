const EARTH_RADIUS_METERS = 6_371_000;
const MAX_RUNNER_SPEED_MPS = 12;
const MIN_MOVING_SPEED_MPS = 0.5;
const MAX_SEGMENT_GAP_SECONDS = 5;
const MAX_ACCURACY_METERS = 35;

export type TrackPoint = {
  accuracy: number | null;
  latitude: number;
  longitude: number;
  speed: number | null;
  timestamp: number;
};

export type SegmentResult = {
  accepted: boolean;
  distanceMeters: number;
  reason: 'accepted' | 'gap' | 'invalid-time' | 'jump' | 'stationary' | 'weak-gps';
  shouldAdvance: boolean;
  speedMps: number;
};

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

export function distanceBetweenMeters(a: TrackPoint, b: TrackPoint): number {
  const latitudeDelta = toRadians(b.latitude - a.latitude);
  const longitudeDelta = toRadians(b.longitude - a.longitude);
  const latitudeA = toRadians(a.latitude);
  const latitudeB = toRadians(b.latitude);

  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitudeA) * Math.cos(latitudeB) * Math.sin(longitudeDelta / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(haversine));
}

export function analyzeSegment(previous: TrackPoint, current: TrackPoint): SegmentResult {
  if (current.accuracy === null || current.accuracy > MAX_ACCURACY_METERS) {
    return { accepted: false, distanceMeters: 0, reason: 'weak-gps', shouldAdvance: false, speedMps: 0 };
  }

  const seconds = (current.timestamp - previous.timestamp) / 1000;
  if (seconds <= 0) {
    return { accepted: false, distanceMeters: 0, reason: 'invalid-time', shouldAdvance: false, speedMps: 0 };
  }

  if (seconds > MAX_SEGMENT_GAP_SECONDS) {
    return { accepted: false, distanceMeters: 0, reason: 'gap', shouldAdvance: true, speedMps: 0 };
  }

  const distanceMeters = distanceBetweenMeters(previous, current);
  const derivedSpeed = distanceMeters / seconds;
  const sensorSpeed = current.speed !== null && current.speed >= 0 ? current.speed : null;
  const speedMps = sensorSpeed ?? derivedSpeed;

  if (speedMps > MAX_RUNNER_SPEED_MPS || derivedSpeed > MAX_RUNNER_SPEED_MPS * 1.35) {
    return { accepted: false, distanceMeters: 0, reason: 'jump', shouldAdvance: false, speedMps: 0 };
  }

  if (speedMps < MIN_MOVING_SPEED_MPS || distanceMeters < 0.35) {
    return { accepted: false, distanceMeters: 0, reason: 'stationary', shouldAdvance: true, speedMps: 0 };
  }

  return { accepted: true, distanceMeters, reason: 'accepted', shouldAdvance: true, speedMps };
}

export function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const twoDigits = (value: number) => value.toString().padStart(2, '0');

  return hours > 0
    ? `${twoDigits(hours)}:${twoDigits(minutes)}:${twoDigits(seconds)}`
    : `${twoDigits(minutes)}:${twoDigits(seconds)}`;
}

export function formatPaceFromSpeed(speedMetersPerSecond: number): string {
  if (!Number.isFinite(speedMetersPerSecond) || speedMetersPerSecond < MIN_MOVING_SPEED_MPS) {
    return '—';
  }

  const paceSeconds = Math.min(5999, Math.round(1000 / speedMetersPerSecond));
  const minutes = Math.floor(paceSeconds / 60);
  const seconds = paceSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

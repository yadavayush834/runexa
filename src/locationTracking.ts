import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import { analyzeSegment, type TrackPoint } from './runMath';

export const RUN_LOCATION_TASK = 'runexa-active-run-location';
const RUN_STORAGE_KEY = 'runexa.active-run.v1';
const MAX_ACCURACY_METERS = 35;
const SPEED_SAMPLE_COUNT = 3;

export type RunSnapshot = {
  accuracyMeters: number | null;
  accumulatedMs: number;
  active: boolean;
  distanceMeters: number;
  lastPoint: TrackPoint | null;
  latitude: number | null;
  longitude: number | null;
  speedMps: number;
  speedSamples: number[];
  startedAt: number | null;
  updatedAt: number | null;
};

export const EMPTY_RUN_SNAPSHOT: RunSnapshot = {
  accuracyMeters: null,
  accumulatedMs: 0,
  active: false,
  distanceMeters: 0,
  lastPoint: null,
  latitude: null,
  longitude: null,
  speedMps: 0,
  speedSamples: [],
  startedAt: null,
  updatedAt: null,
};

export const LIVE_LOCATION_OPTIONS: Location.LocationOptions = {
  accuracy: Location.Accuracy.BestForNavigation,
  distanceInterval: 0,
  timeInterval: 1000,
  mayShowUserSettingsDialog: true,
};

type SnapshotListener = (snapshot: RunSnapshot) => void;
type LocationTaskData = { locations?: Location.LocationObject[] };

let cachedSnapshot: RunSnapshot | null = null;
let mutationQueue: Promise<unknown> = Promise.resolve();
const listeners = new Set<SnapshotListener>();

function copySnapshot(snapshot: RunSnapshot): RunSnapshot {
  return {
    ...snapshot,
    lastPoint: snapshot.lastPoint ? { ...snapshot.lastPoint } : null,
    speedSamples: [...snapshot.speedSamples],
  };
}

function isRunSnapshot(value: unknown): value is RunSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RunSnapshot>;
  return (
    typeof candidate.active === 'boolean' &&
    typeof candidate.accumulatedMs === 'number' &&
    typeof candidate.distanceMeters === 'number' &&
    Array.isArray(candidate.speedSamples)
  );
}

async function readSnapshot(): Promise<RunSnapshot> {
  if (cachedSnapshot) return copySnapshot(cachedSnapshot);

  try {
    const raw = await AsyncStorage.getItem(RUN_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    cachedSnapshot = isRunSnapshot(parsed)
      ? { ...EMPTY_RUN_SNAPSHOT, ...parsed, speedSamples: parsed.speedSamples.slice(-SPEED_SAMPLE_COUNT) }
      : copySnapshot(EMPTY_RUN_SNAPSHOT);
  } catch {
    cachedSnapshot = copySnapshot(EMPTY_RUN_SNAPSHOT);
  }

  return copySnapshot(cachedSnapshot);
}

function publish(snapshot: RunSnapshot) {
  const publicCopy = copySnapshot(snapshot);
  listeners.forEach((listener) => listener(publicCopy));
}

function mutateSnapshot(
  transform: (current: RunSnapshot) => RunSnapshot | Promise<RunSnapshot>,
): Promise<RunSnapshot> {
  const operation = mutationQueue.then(async () => {
    const current = await readSnapshot();
    const next = await transform(current);
    cachedSnapshot = copySnapshot(next);
    await AsyncStorage.setItem(RUN_STORAGE_KEY, JSON.stringify(next));
    publish(next);
    return copySnapshot(next);
  });

  mutationQueue = operation.catch(() => undefined);
  return operation;
}

function applyLocation(snapshot: RunSnapshot, location: Location.LocationObject): RunSnapshot {
  if (!snapshot.active) return snapshot;

  const point: TrackPoint = {
    accuracy: location.coords.accuracy,
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    speed: location.coords.speed,
    timestamp: location.timestamp,
  };
  const next: RunSnapshot = {
    ...snapshot,
    accuracyMeters: point.accuracy,
    latitude: point.latitude,
    longitude: point.longitude,
    updatedAt: point.timestamp,
  };

  if (point.accuracy === null || point.accuracy > MAX_ACCURACY_METERS) {
    return { ...next, speedMps: 0, speedSamples: [] };
  }
  if (!snapshot.lastPoint) return { ...next, lastPoint: point };

  const segment = analyzeSegment(snapshot.lastPoint, point);
  if (segment.shouldAdvance) next.lastPoint = point;
  if (!segment.accepted) {
    return segment.reason === 'stationary' || segment.reason === 'gap'
      ? { ...next, speedMps: 0, speedSamples: [] }
      : next;
  }

  const samples = [...snapshot.speedSamples, segment.speedMps].slice(-SPEED_SAMPLE_COUNT);
  return {
    ...next,
    distanceMeters: snapshot.distanceMeters + segment.distanceMeters,
    speedMps: samples.reduce((sum, speed) => sum + speed, 0) / samples.length,
    speedSamples: samples,
  };
}

export async function recordLocations(locations: Location.LocationObject[]): Promise<RunSnapshot> {
  return mutateSnapshot((current) =>
    [...locations]
      .sort((a, b) => a.timestamp - b.timestamp)
      .reduce(applyLocation, current),
  );
}

export async function loadRunSnapshot(): Promise<RunSnapshot> {
  await mutationQueue;
  return readSnapshot();
}

export function subscribeRunSnapshot(listener: SnapshotListener): () => void {
  listeners.add(listener);
  if (cachedSnapshot) listener(copySnapshot(cachedSnapshot));
  return () => listeners.delete(listener);
}

export function elapsedMilliseconds(snapshot: RunSnapshot, now = Date.now()): number {
  return snapshot.accumulatedMs + (snapshot.startedAt === null ? 0 : Math.max(0, now - snapshot.startedAt));
}

export async function resumeRunSession(): Promise<RunSnapshot> {
  return mutateSnapshot((current) => ({
    ...current,
    active: true,
    lastPoint: null,
    speedMps: 0,
    speedSamples: [],
    startedAt: current.startedAt ?? Date.now(),
  }));
}

export async function pauseRunSession(): Promise<RunSnapshot> {
  const now = Date.now();
  return mutateSnapshot((current) => ({
    ...current,
    accumulatedMs: elapsedMilliseconds(current, now),
    active: false,
    lastPoint: null,
    speedMps: 0,
    speedSamples: [],
    startedAt: null,
  }));
}

export async function resetRunSession(): Promise<RunSnapshot> {
  return mutateSnapshot(() => copySnapshot(EMPTY_RUN_SNAPSHOT));
}

export async function canTrackInBackground(): Promise<boolean> {
  const [taskManagerAvailable, locationAvailable, permission] = await Promise.all([
    TaskManager.isAvailableAsync(),
    Location.isBackgroundLocationAvailableAsync(),
    Location.getBackgroundPermissionsAsync(),
  ]);
  return taskManagerAvailable && locationAvailable && permission.granted;
}

export async function startBackgroundLocationUpdates(): Promise<void> {
  if (await Location.hasStartedLocationUpdatesAsync(RUN_LOCATION_TASK)) return;

  await Location.startLocationUpdatesAsync(RUN_LOCATION_TASK, {
    ...LIVE_LOCATION_OPTIONS,
    activityType: Location.ActivityType.Fitness,
    deferredUpdatesDistance: 0,
    deferredUpdatesInterval: 0,
    foregroundService: {
      killServiceOnDestroy: false,
      notificationBody: 'Runexa is measuring your live distance and pace.',
      notificationColor: '#FF6B4A',
      notificationTitle: 'Run in progress',
    },
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
  });
}

export async function stopBackgroundLocationUpdates(): Promise<void> {
  if (await Location.hasStartedLocationUpdatesAsync(RUN_LOCATION_TASK)) {
    await Location.stopLocationUpdatesAsync(RUN_LOCATION_TASK);
  }
}

if (!TaskManager.isTaskDefined(RUN_LOCATION_TASK)) {
  TaskManager.defineTask<LocationTaskData>(RUN_LOCATION_TASK, async ({ data, error }) => {
    if (error || !data?.locations?.length) return;
    await recordLocations(data.locations);
  });
}

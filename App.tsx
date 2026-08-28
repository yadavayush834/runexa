import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StatusBar as NativeStatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as KeepAwake from 'expo-keep-awake';
import * as Location from 'expo-location';

import {
  formatElapsed,
  formatPaceFromSpeed,
} from './src/runMath';
import {
  canTrackInBackground,
  elapsedMilliseconds,
  EMPTY_RUN_SNAPSHOT,
  LIVE_LOCATION_OPTIONS,
  loadRunSnapshot,
  pauseRunSession,
  recordLocations,
  resetRunSession,
  resumeRunSession,
  startBackgroundLocationUpdates,
  stopBackgroundLocationUpdates,
  subscribeRunSnapshot,
  type RunSnapshot,
} from './src/locationTracking';

const COLORS = {
  asphalt: '#0B1114',
  panel: '#121B20',
  raised: '#18242A',
  line: '#28383F',
  fog: '#E4EEF0',
  mist: '#8FA5AB',
  coral: '#FF6B4A',
  mint: '#65D6C1',
  amber: '#FFD166',
  danger: '#FF8B7A',
};

const KEEP_AWAKE_TAG = 'runexa-live-run';
const MAX_ACCURACY_METERS = 35;

type TrackerState =
  | 'ready'
  | 'requesting'
  | 'acquiring'
  | 'running'
  | 'paused'
  | 'error';

type TrackingMode = 'background' | 'foreground' | null;

const displayFont = Platform.select({ android: 'sans-serif-condensed', default: 'System' });

function averagePace(distanceMeters: number, elapsedMs: number): string {
  if (distanceMeters < 10 || elapsedMs <= 0) return '—';
  return formatPaceFromSpeed(distanceMeters / (elapsedMs / 1000));
}

function formatDistanceKilometers(distanceMeters: number): string {
  return (distanceMeters / 1000).toFixed(distanceMeters < 1000 ? 3 : 2);
}

function stateCopy(state: TrackerState, accuracy: number | null) {
  if (state === 'requesting') return { label: 'CHECKING ACCESS', tone: COLORS.amber };
  if (state === 'acquiring') return { label: 'FINDING GPS', tone: COLORS.amber };
  if (state === 'running' && accuracy !== null && accuracy > MAX_ACCURACY_METERS) {
    return { label: 'WEAK GPS', tone: COLORS.amber };
  }
  if (state === 'running') return { label: 'LIVE', tone: COLORS.mint };
  if (state === 'paused') return { label: 'PAUSED', tone: COLORS.mist };
  if (state === 'error') return { label: 'GPS ISSUE', tone: COLORS.danger };
  return { label: 'READY', tone: COLORS.mist };
}

function explainAndRequestBackgroundPermission(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      'Track when the screen is locked?',
      'Runexa needs background location so distance keeps updating when you lock your phone or switch apps. You can continue with foreground-only tracking instead.',
      [
        { onPress: () => resolve(false), style: 'cancel', text: 'Keep app open' },
        {
          onPress: () => {
            void Location.requestBackgroundPermissionsAsync()
              .then((permission) => resolve(permission.granted))
              .catch(() => resolve(false));
          },
          text: 'Continue',
        },
      ],
      { cancelable: false },
    );
  });
}

export default function App() {
  const [trackerState, setTrackerState] = useState<TrackerState>('ready');
  const [runSnapshot, setRunSnapshot] = useState<RunSnapshot>(() => ({ ...EMPTY_RUN_SNAPSHOT }));
  const [clockNow, setClockNow] = useState(Date.now());
  const [trackingMode, setTrackingMode] = useState<TrackingMode>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const locationSubscriptionRef = useRef<Location.LocationSubscription | null>(null);
  const pulse = useRef(new Animated.Value(0)).current;

  const metrics = runSnapshot;
  const elapsedMs = elapsedMilliseconds(runSnapshot, clockNow);
  const isTracking = trackerState === 'acquiring' || trackerState === 'running';
  const isBusy = trackerState === 'requesting';
  const hasRunData = elapsedMs > 0 || metrics.distanceMeters > 0;

  const releaseForegroundResources = useCallback(() => {
    locationSubscriptionRef.current?.remove();
    locationSubscriptionRef.current = null;
    void KeepAwake.deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => undefined);
  }, []);

  const handleLocation = useCallback((location: Location.LocationObject) => {
    void recordLocations([location]).catch((error: unknown) => {
      setErrorMessage(error instanceof Error ? error.message : 'Could not save the GPS update.');
      setTrackerState('error');
    });
  }, []);

  const startTracking = useCallback(async () => {
    if (isTracking || isBusy) return;

    setErrorMessage(null);
    setTrackerState('requesting');

    try {
      const servicesEnabled = await Location.hasServicesEnabledAsync();
      if (!servicesEnabled) {
        throw new Error('Turn on Location Services in your phone settings, then try again.');
      }

      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== Location.PermissionStatus.GRANTED) {
        throw new Error('Location access is required to measure your run. Allow it in phone settings.');
      }
      if (Platform.OS === 'android' && permission.android?.accuracy !== 'fine') {
        throw new Error('Runexa has approximate location only. Enable Precise location for Runexa in phone settings.');
      }
      if (Platform.OS === 'ios' && permission.ios?.accuracy === 'reduced') {
        throw new Error('Runexa needs Precise Location enabled to calculate distance reliably.');
      }

      if (Platform.OS === 'android') {
        await Location.enableNetworkProviderAsync().catch(() => undefined);
      }

      const existingBackgroundPermission = await Location.getBackgroundPermissionsAsync();
      const backgroundGranted = existingBackgroundPermission.granted
        ? true
        : await explainAndRequestBackgroundPermission();

      setTrackerState('acquiring');
      await resumeRunSession();

      if (backgroundGranted && (await canTrackInBackground())) {
        await startBackgroundLocationUpdates();
        setTrackingMode('background');
      } else {
        locationSubscriptionRef.current = await Location.watchPositionAsync(
          LIVE_LOCATION_OPTIONS,
          handleLocation,
          (reason) => {
            releaseForegroundResources();
            void pauseRunSession();
            setErrorMessage(`GPS stopped: ${reason}`);
            setTrackerState('error');
          },
        );
        setTrackingMode('foreground');
        await KeepAwake.activateKeepAwakeAsync(KEEP_AWAKE_TAG);
      }
    } catch (error) {
      releaseForegroundResources();
      await stopBackgroundLocationUpdates().catch(() => undefined);
      await pauseRunSession().catch(() => undefined);
      setTrackingMode(null);
      setErrorMessage(error instanceof Error ? error.message : 'GPS could not be started.');
      setTrackerState('error');
    }
  }, [handleLocation, isBusy, isTracking, releaseForegroundResources]);

  const pauseTracking = useCallback(async () => {
    releaseForegroundResources();
    await stopBackgroundLocationUpdates().catch(() => undefined);
    await pauseRunSession();
    setTrackingMode(null);
    setTrackerState('paused');
  }, [releaseForegroundResources]);

  const resetRun = useCallback(async () => {
    if (isTracking || isBusy) return;
    await resetRunSession();
    setClockNow(Date.now());
    setErrorMessage(null);
    setTrackerState('ready');
  }, [isBusy, isTracking]);

  useEffect(() => {
    let mounted = true;
    const applySnapshot = (snapshot: RunSnapshot) => {
      if (!mounted) return;
      setRunSnapshot(snapshot);
      setClockNow(Date.now());
      if (snapshot.active) {
        setTrackerState(snapshot.updatedAt === null ? 'acquiring' : 'running');
      } else if (elapsedMilliseconds(snapshot) > 0 || snapshot.distanceMeters > 0) {
        setTrackerState('paused');
      }
    };
    const unsubscribe = subscribeRunSnapshot(applySnapshot);
    void loadRunSnapshot().then(async (snapshot) => {
      applySnapshot(snapshot);
      if (!snapshot.active) return;

      try {
        if (await canTrackInBackground()) {
          await startBackgroundLocationUpdates();
          setTrackingMode('background');
        } else {
          await pauseRunSession();
          setTrackingMode(null);
        }
      } catch (error) {
        await pauseRunSession().catch(() => undefined);
        setErrorMessage(error instanceof Error ? error.message : 'The previous run could not be resumed.');
        setTrackerState('error');
      }
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!runSnapshot.active) return;
    const clock = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, [runSnapshot.active]);

  useEffect(() => {
    if (!isTracking) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }

    const animation = Animated.loop(
      Animated.timing(pulse, {
        duration: 1500,
        toValue: 1,
        useNativeDriver: true,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [isTracking, pulse]);

  useEffect(() => () => releaseForegroundResources(), [releaseForegroundResources]);

  const livePace = formatPaceFromSpeed(metrics.speedMps);
  const speedKmh = metrics.speedMps * 3.6;
  const kilometersPerMinute = metrics.speedMps * 0.06;
  const status = stateCopy(trackerState, metrics.accuracyMeters);
  const paceParts = livePace === '—' ? ['—', ''] : livePace.split(':');

  const mainAction = useMemo(() => {
    if (isBusy) return { label: 'Checking GPS…', onPress: startTracking };
    if (isTracking) return { label: 'Pause run', onPress: pauseTracking };
    if (trackerState === 'paused') return { label: 'Resume run', onPress: startTracking };
    if (trackerState === 'error') return { label: 'Try GPS again', onPress: startTracking };
    return { label: 'Start run', onPress: startTracking };
  }, [isBusy, isTracking, pauseTracking, startTracking, trackerState]);

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View>
            <Text style={styles.wordmark}>RUNEXA</Text>
            <Text style={styles.kicker}>LIVE RUN CONSOLE</Text>
          </View>
          <View style={[styles.statusPill, { borderColor: status.tone }]}>
            <View style={[styles.statusDot, { backgroundColor: status.tone }]} />
            <Text style={[styles.statusText, { color: status.tone }]}>{status.label}</Text>
          </View>
        </View>

        <View style={styles.hero}>
          <View style={styles.gpsOrb} accessible accessibilityLabel={`${status.label} GPS status`}>
            <Animated.View
              style={[
                styles.pulseRing,
                {
                  borderColor: status.tone,
                  opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.7, 0] }),
                  transform: [
                    { scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.78, 1.18] }) },
                  ],
                },
              ]}
            />
            <View style={[styles.orbCore, { backgroundColor: status.tone }]} />
          </View>

          <Text style={styles.metricLabel}>LIVE PACE</Text>
          <View style={styles.paceLine}>
            <Text style={styles.paceMajor}>{paceParts[0]}</Text>
            {paceParts[1] ? <Text style={styles.paceMinor}>:{paceParts[1]}</Text> : null}
          </View>
          <Text style={styles.paceUnit}>MIN / KM</Text>
          <Text style={styles.heroHint}>
            {trackerState === 'ready' && 'Start outside with a clear view of the sky.'}
            {trackerState === 'requesting' && 'Waiting for location permission.'}
            {trackerState === 'acquiring' && 'Hold steady while GPS finds you.'}
            {trackerState === 'running' && trackingMode === 'background' &&
              'Live tracking stays active when the screen is locked.'}
            {trackerState === 'running' && trackingMode !== 'background' &&
              'Live every second. Keep Runexa open for this run.'}
            {trackerState === 'paused' && 'Your run is paused. Movement is not counted.'}
            {trackerState === 'error' && errorMessage}
          </Text>
        </View>

        <View style={styles.primaryStats}>
          <View style={styles.primaryStat}>
            <Text style={styles.statLabel}>TIME</Text>
            <Text style={styles.statValue}>{formatElapsed(elapsedMs)}</Text>
          </View>
          <View style={styles.verticalRule} />
          <View style={styles.primaryStat}>
            <Text style={styles.statLabel}>DISTANCE</Text>
            <Text style={styles.statValue}>{formatDistanceKilometers(metrics.distanceMeters)}</Text>
            <Text style={styles.statUnit}>KM</Text>
          </View>
        </View>

        <View style={styles.grid}>
          <View style={styles.dataCard}>
            <Text style={styles.cardLabel}>KM PER MIN</Text>
            <Text style={styles.cardValue}>{kilometersPerMinute.toFixed(3)}</Text>
            <Text style={styles.cardCaption}>LIVE OUTPUT</Text>
          </View>
          <View style={styles.dataCard}>
            <Text style={styles.cardLabel}>SPEED</Text>
            <Text style={styles.cardValue}>{speedKmh.toFixed(1)}</Text>
            <Text style={styles.cardCaption}>KM / H</Text>
          </View>
          <View style={styles.dataCard}>
            <Text style={styles.cardLabel}>AVG PACE</Text>
            <Text style={styles.cardValue}>{averagePace(metrics.distanceMeters, elapsedMs)}</Text>
            <Text style={styles.cardCaption}>MIN / KM</Text>
          </View>
          <View style={styles.dataCard}>
            <Text style={styles.cardLabel}>GPS ACCURACY</Text>
            <Text style={styles.cardValue}>
              {metrics.accuracyMeters === null ? '—' : Math.round(metrics.accuracyMeters)}
            </Text>
            <Text style={styles.cardCaption}>± METERS</Text>
          </View>
        </View>

        <View style={styles.coordinateStrip}>
          <View>
            <Text style={styles.coordinateLabel}>CURRENT GPS</Text>
            <Text style={styles.coordinateValue}>
              {metrics.latitude === null
                ? 'Waiting for coordinates'
                : `${metrics.latitude.toFixed(5)},  ${metrics.longitude?.toFixed(5)}`}
            </Text>
          </View>
          <Text style={styles.localOnly}>LOCAL</Text>
        </View>

        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={mainAction.label}
            disabled={isBusy}
            onPress={mainAction.onPress}
            style={({ pressed }) => [
              styles.mainButton,
              isTracking && styles.pauseButton,
              pressed && styles.buttonPressed,
              isBusy && styles.buttonDisabled,
            ]}
          >
            <View style={[styles.actionIcon, isTracking && styles.pauseIcon]}>
              {isTracking ? (
                <>
                  <View style={styles.pauseBar} />
                  <View style={styles.pauseBar} />
                </>
              ) : (
                <View style={styles.playIcon} />
              )}
            </View>
            <Text style={styles.mainButtonText}>{mainAction.label}</Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Reset run"
            disabled={!hasRunData || isTracking || isBusy}
            onPress={resetRun}
            style={({ pressed }) => [
              styles.resetButton,
              pressed && styles.buttonPressed,
              (!hasRunData || isTracking || isBusy) && styles.resetDisabled,
            ]}
          >
            <Text style={styles.resetText}>RESET</Text>
          </Pressable>
        </View>

        <Text style={styles.privacyNote}>LIVE GPS · NO ACCOUNT · NO UPLOAD</Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.asphalt },
  content: {
    flexGrow: 1,
    paddingBottom: 30,
    paddingHorizontal: 20,
    paddingTop: (NativeStatusBar.currentHeight ?? 0) + 18,
  },
  header: { alignItems: 'flex-start', flexDirection: 'row', justifyContent: 'space-between' },
  wordmark: {
    color: COLORS.fog,
    fontFamily: displayFont,
    fontSize: 25,
    fontWeight: '900',
    letterSpacing: 3.5,
    lineHeight: 27,
  },
  kicker: {
    color: COLORS.mist,
    fontFamily: 'monospace',
    fontSize: 9,
    letterSpacing: 1.5,
    marginTop: 5,
  },
  statusPill: {
    alignItems: 'center',
    borderRadius: 20,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  statusDot: { borderRadius: 4, height: 7, width: 7 },
  statusText: {
    fontFamily: 'monospace',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1,
  },
  hero: { alignItems: 'center', minHeight: 300, paddingTop: 31 },
  gpsOrb: {
    alignItems: 'center',
    height: 40,
    justifyContent: 'center',
    marginBottom: 14,
    width: 40,
  },
  pulseRing: {
    borderRadius: 25,
    borderWidth: 1.5,
    height: 40,
    position: 'absolute',
    width: 40,
  },
  orbCore: { borderRadius: 6, height: 11, width: 11 },
  metricLabel: {
    color: COLORS.mist,
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2.4,
  },
  paceLine: {
    alignItems: 'baseline',
    flexDirection: 'row',
    height: 105,
    justifyContent: 'center',
    marginTop: 2,
  },
  paceMajor: {
    color: COLORS.fog,
    fontFamily: displayFont,
    fontSize: 100,
    fontWeight: '200',
    letterSpacing: -4,
    lineHeight: 112,
  },
  paceMinor: {
    color: COLORS.fog,
    fontFamily: displayFont,
    fontSize: 58,
    fontWeight: '300',
    letterSpacing: -2,
  },
  paceUnit: {
    color: COLORS.coral,
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 2,
  },
  heroHint: {
    color: COLORS.mist,
    fontSize: 12,
    lineHeight: 18,
    marginTop: 19,
    maxWidth: 290,
    minHeight: 36,
    textAlign: 'center',
  },
  primaryStats: {
    alignItems: 'stretch',
    backgroundColor: COLORS.panel,
    borderColor: COLORS.line,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    marginBottom: 12,
    paddingVertical: 18,
  },
  primaryStat: { alignItems: 'center', flex: 1 },
  verticalRule: { backgroundColor: COLORS.line, width: 1 },
  statLabel: {
    color: COLORS.mist,
    fontFamily: 'monospace',
    fontSize: 9,
    letterSpacing: 1.5,
    marginBottom: 7,
  },
  statValue: {
    color: COLORS.fog,
    fontFamily: displayFont,
    fontSize: 31,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  statUnit: {
    color: COLORS.mist,
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 1.2,
    marginTop: -1,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 12 },
  dataCard: {
    backgroundColor: COLORS.raised,
    borderRadius: 14,
    minHeight: 104,
    padding: 14,
    width: '48.5%',
  },
  cardLabel: {
    color: COLORS.mist,
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 1.1,
  },
  cardValue: {
    color: COLORS.fog,
    fontFamily: displayFont,
    fontSize: 28,
    fontWeight: '600',
    marginTop: 8,
  },
  cardCaption: {
    color: COLORS.mist,
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 1,
    marginTop: 2,
  },
  coordinateStrip: {
    alignItems: 'center',
    borderBottomColor: COLORS.line,
    borderBottomWidth: 1,
    borderTopColor: COLORS.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 20,
    paddingHorizontal: 2,
    paddingVertical: 14,
  },
  coordinateLabel: {
    color: COLORS.mist,
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 1.2,
    marginBottom: 4,
  },
  coordinateValue: { color: COLORS.fog, fontFamily: 'monospace', fontSize: 11 },
  localOnly: {
    color: COLORS.mint,
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 1.2,
  },
  actions: { flexDirection: 'row', gap: 10 },
  mainButton: {
    alignItems: 'center',
    backgroundColor: COLORS.coral,
    borderRadius: 16,
    flex: 1,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'center',
    minHeight: 61,
  },
  pauseButton: { backgroundColor: COLORS.fog },
  buttonPressed: { opacity: 0.76, transform: [{ scale: 0.985 }] },
  buttonDisabled: { opacity: 0.58 },
  actionIcon: {
    alignItems: 'center',
    flexDirection: 'row',
    height: 18,
    justifyContent: 'center',
    width: 18,
  },
  pauseIcon: { gap: 4 },
  playIcon: {
    borderBottomWidth: 7,
    borderLeftColor: COLORS.asphalt,
    borderLeftWidth: 12,
    borderTopWidth: 7,
    height: 0,
    width: 0,
  },
  pauseBar: { backgroundColor: COLORS.asphalt, borderRadius: 1, height: 16, width: 4 },
  mainButtonText: {
    color: COLORS.asphalt,
    fontFamily: displayFont,
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  resetButton: {
    alignItems: 'center',
    borderColor: COLORS.line,
    borderRadius: 16,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 61,
    width: 82,
  },
  resetDisabled: { opacity: 0.3 },
  resetText: {
    color: COLORS.mist,
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.1,
  },
  privacyNote: {
    color: COLORS.mist,
    fontFamily: 'monospace',
    fontSize: 8,
    letterSpacing: 1.2,
    marginTop: 18,
    opacity: 0.68,
    textAlign: 'center',
  },
});

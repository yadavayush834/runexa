import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeSegment,
  distanceBetweenMeters,
  formatElapsed,
  formatPaceFromSpeed,
} from './runMath.ts';

const BASE = {
  accuracy: 5,
  latitude: 28.6139,
  longitude: 77.209,
  speed: null,
  timestamp: 1_000,
};

function point(overrides) {
  return { ...BASE, ...overrides };
}

test('distanceBetweenMeters returns a realistic short walking segment', () => {
  const distance = distanceBetweenMeters(BASE, point({ latitude: BASE.latitude + 0.00001 }));
  assert.ok(distance > 1 && distance < 1.2);
});

test('uses coordinate movement when Android temporarily reports zero native speed', () => {
  const result = analyzeSegment(
    BASE,
    point({ latitude: BASE.latitude + 0.000012, speed: 0, timestamp: 2_000 }),
  );

  assert.equal(result.accepted, true);
  assert.ok(result.distanceMeters > 1.2);
  assert.ok(result.speedMps > 1.2);
});

test('accepts valid movement when an Android update is delayed', () => {
  const result = analyzeSegment(
    BASE,
    point({ latitude: BASE.latitude + 0.0001, speed: 1.4, timestamp: 9_000 }),
  );

  assert.equal(result.accepted, true);
  assert.ok(result.distanceMeters > 10);
});

test('does not bridge a long location outage', () => {
  const result = analyzeSegment(
    BASE,
    point({ latitude: BASE.latitude + 0.0004, speed: 1.4, timestamp: 32_000 }),
  );

  assert.deepEqual(result, {
    accepted: false,
    distanceMeters: 0,
    reason: 'gap',
    shouldAdvance: true,
    speedMps: 0,
  });
});

test('rejects weak fixes, stationary jitter, and impossible jumps', () => {
  assert.equal(
    analyzeSegment(BASE, point({ accuracy: 80, latitude: BASE.latitude + 0.00001, timestamp: 2_000 })).reason,
    'weak-gps',
  );
  assert.equal(
    analyzeSegment(BASE, point({ latitude: BASE.latitude + 0.000001, speed: 0, timestamp: 2_000 })).reason,
    'stationary',
  );
  assert.equal(
    analyzeSegment(BASE, point({ latitude: BASE.latitude + 0.001, speed: 2, timestamp: 2_000 })).reason,
    'jump',
  );
});

test('formats elapsed time and pace', () => {
  assert.equal(formatElapsed(65_999), '01:05');
  assert.equal(formatElapsed(3_661_000), '01:01:01');
  assert.equal(formatPaceFromSpeed(2.5), '6:40');
  assert.equal(formatPaceFromSpeed(0), '—');
});

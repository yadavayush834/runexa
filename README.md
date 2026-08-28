# Runexa

A lightweight, Android-first React Native running tracker. Runexa reads navigation-grade GPS updates about once per second and shows live pace, elapsed time, distance, km/min, km/h, average pace, GPS accuracy, and current coordinates.

## What it does

- Requests precise foreground location for every run
- Can keep an active run measuring through a foreground service when the screen is locked
- Falls back to foreground-only tracking when background access is unavailable
- Filters weak GPS fixes, long gaps, stationary jitter, and impossible jumps
- Works around Android fixes that report zero native speed despite real coordinate movement
- Persists the active run locally so native background callbacks can update it
- Pauses and resumes without counting movement during the pause
- Uses no account, backend, map SDK, analytics, or GPS upload

GPS update frequency is controlled by the phone and may not be exactly one update every second. Distance and pace are estimates and should not be used for safety-critical navigation.

## Run on an Android phone

Requirements: Node.js 22.13 or newer and an Android phone.

```powershell
npm install
npx expo start
```

For SDK 57, use a development build or an Expo Go version compatible with SDK 57. Scan the terminal QR code while the phone and computer are on the same network. Expo Go uses Runexa's foreground fallback; screen-locked/background tracking requires a new native build.

When starting a run, grant Precise location. Grant background location if you want tracking to continue with the screen locked; choosing "Keep app open" still starts a foreground-only run.

## Build an installable APK

Sign in to an Expo account, then run:

```powershell
npx eas-cli login
npx eas-cli build --platform android --profile preview
```

The `preview` profile in `eas.json` produces an `.apk` that can be downloaded from the EAS build page and installed directly on Android. The `production` profile produces an `.aab` for Google Play.

## Verify

```powershell
npm run verify
```

The verification command runs the distance/speed regression suite, TypeScript, and Expo Doctor. A real outdoor phone walk/run remains necessary to validate GPS hardware behavior; emulators and desktop checks cannot prove sensor accuracy.

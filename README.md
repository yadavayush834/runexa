# Runexa

A lightweight, Android-first React Native running tracker. Runexa reads foreground GPS updates about once per second and shows live pace, elapsed time, distance, km/min, km/h, average pace, GPS accuracy, and current coordinates.

## What it does

- Requests location only while you use the app
- Filters weak GPS fixes, long gaps, stationary jitter, and impossible jumps
- Keeps the screen awake while a run is active
- Pauses and resumes without counting movement during the pause
- Uses no account, backend, map SDK, analytics, or GPS upload

GPS update frequency is controlled by Android and may not be exactly one update every second. Distance and pace are estimates and should not be used for safety-critical navigation.

## Run on an Android phone

Requirements: Node.js 22.13 or newer and an Android phone.

```powershell
npm install
npx expo start
```

For SDK 57, use a development build or an Expo Go version compatible with SDK 57. Scan the terminal QR code while the phone and computer are on the same network.

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

The app intentionally tracks only while it is visible. Background tracking would require broader Android permissions, a foreground service, and additional battery/privacy handling.

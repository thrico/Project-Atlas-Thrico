# How the build worker works

## The whole flow

```
Admin dashboard ──"Queue build"──▶ thrico-logic ──{buildId, appId, platform, gitRef}──▶ SQS (FIFO, group "builds")
                                        ▲                                                    │
          live steps + logs on          │ GET  /worker/builds/:id/bundle   (app + keys)      ▼
          the Builds page ◀─────────────┤ POST /worker/builds/:id/report   (steps, result)   Atlas worker
                                        │ POST /worker/builds/:id/logs     (output lines)    (build Mac)
                                        └────────────────────────────────────────────────────┘
```

1. An admin queues a build of a `release/*` branch for one app and one platform. thrico-logic records
   the build (status `queued`) and puts a message on SQS holding ids only, never keys.
2. The worker long-polls the queue and takes one message at a time.
3. It fetches the **bundle** for that build: app settings, version, branding and the decrypted keys.
   thrico-logic hands this out only while the build is queued or running.
4. It runs the pipeline, reporting each step and streaming every command's output.
5. It sends the final report (succeeded or failed), and only then deletes the message.

On failure thrico-logic emails and posts to Slack. The worker does not alert anyone itself.

All calls to thrico-logic send `Authorization: Bearer BUILD_WORKER_TOKEN`.

## The bundle

`GET /worker/builds/:id/bundle` returns:

```json
{
  "build": { "id", "platform": "android|ios", "gitRef", "versionName", "buildNumber" },
  "app": { "id", "entityId", "appName", "androidPackageName", "iosBundleId",
           "branding", "android", "ios", "eas", "cdnUrl" },
  "secrets": { "<key>": { "kind": "text|file", "fileName?", "value" } }
}
```

File values are base64. A `409` means the build was cancelled or already ended: the worker skips it.

`prepareBuild` (`src/steps/config.ts`) turns this into the pipeline's `MobilePublishPayload`:

| Key                                                        | Written to                              | Used for                                                    |
| ---------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------- |
| `android_keystore`                                         | `.build-keys/release.keystore`          | Gradle signing                                              |
| `android_keystorePassword`, `android_keyPassword`          | (in memory)                             | Gradle signing                                              |
| `android_playServiceAccountJson`                           | `.build-keys/play-service-account.json` | fastlane upload to Play                                     |
| `android_googleServicesJson`                               | `android/app/google-services.json`      | Firebase                                                    |
| `ios_distributionCertP12` + `ios_distributionCertPassword` | `.build-keys/distribution.p12`          | Temporary keychain, code signing                            |
| `ios_provisioningProfile`                                  | `.build-keys/AppStore.mobileprovision`  | Installed to `~/Library/MobileDevice/Provisioning Profiles` |
| `ios_ascApiKeyP8` + `ios_ascApiKeyId` + `ios_ascIssuerId`  | `.build-keys/AuthKey.p8`                | fastlane upload to TestFlight                               |
| `ios_googleServiceInfoPlist`                               | `ios/GoogleService-Info.plist`          | Firebase                                                    |

Everything is written inside `builds/<buildId>/` (`.build-keys` is mode 0700, files 0600) and deleted
with that folder at cleanup. File names are fixed by the worker; the uploaded `fileName` is ignored.
Branding images are CDN keys and become `cdnUrl/<key>`.

Other values: version name and build number come from `build`, the Android key alias from
`app.android.keystoreAlias`, the Apple team id from `app.ios.appleTeamId`.

## Pipeline steps

Each step is reported `running`, then `succeeded` (or `failed`), under these names:

| Step                                           | What happens                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| Clone                                          | Shallow clone of `gitRef`; reports the commit SHA                                 |
| Prepare keys                                   | Writes the keys (table above)                                                     |
| Download assets                                | Downloads the app icon (required) and splash                                      |
| Apply branding                                 | App name, ids, versions, theme, `.env`, OTA channel                               |
| Generate assets                                | Icon and splash sizes                                                             |
| Install dependencies                           | `yarn install`, patches                                                           |
| Apply whitelabeling                            | Font and theme scripts                                                            |
| Build Android / Build iOS                      | Gradle `assembleRelease` + `bundleRelease`, or keychain + pods + fastlane `build` |
| Upload to Play internal / Upload to TestFlight | fastlane upload (see below); reports `storeUpload`                                |
| Save artifacts                                 | Copies APK/AAB/IPA to `artifacts/<buildId>/` on the Mac; reported as `artifacts`  |
| Cleanup                                        | Always runs (below)                                                               |

A missing keystore, certificate, profile or team id fails the build. The worker never generates a
signing key or falls back to automatic signing.

### Store uploads

- **Android**: Play **internal** track, release status **draft**. Draft also works for apps Play still
  lists as draft; an admin rolls it out to testers in Play Console.
- **iOS**: **TestFlight** only (`skip_waiting_for_build_processing`). Submitting for review is done by an
  admin in App Store Connect.

No other track or lane exists in the worker.

## Logs

`src/utils/command.ts` splits each command's stdout and stderr into lines and hands them to the build's
`BuildReporter` (`src/api.ts`). The reporter:

- tags each line with the current step,
- uploads every second, one call per step, at most 500 lines and 250 KB per call (the server allows
  500 lines / 256 KB), lines clipped to 4000 characters,
- never fails the build over a lost log batch,
- on a `409` stops the build: that is how a cancel from the dashboard reaches a running build.

Command arguments are not logged (some contain passwords). thrico-logic also masks every key value
in the lines it stores.

## Failure, retries and time limit

| Situation                                  | What the worker does                                                   | Message |
| ------------------------------------------ | ---------------------------------------------------------------------- | ------- |
| Build fails at a step                      | Reports that step `failed` and the build `failed` with the error       | Deleted |
| Build runs past `BUILD_TIME_LIMIT_MINUTES` | Kills the running command, fails the build "Timed out after N minutes" | Deleted |
| Admin cancels                              | Next report or log call gets 409, build stops                          | Deleted |
| Worker stopped (Ctrl-C / SIGTERM)          | Fails the build "The build worker was stopped"                         | Deleted |
| Bundle returns 409 or 404                  | Skips                                                                  | Deleted |
| Bundle call fails otherwise (API down)     | Retries in 60 s                                                        | Kept    |
| Message delivered more than 3 times        | Reports `failed` "gave up after 3 attempts"                            | Deleted |
| Unreadable message                         | Logs it                                                                | Deleted |

So a build is never retried forever. A failed build is not retried at all: the admin queues a new one.

While a build runs, the message stays hidden (visibility = time limit + 15 minutes, at most 12 hours).
If the worker dies without reporting, thrico-logic fails the build after 3 hours with no report, and the
redelivered message then gets a 409 and is dropped.

The final report is tried 3 times (5 s, 10 s apart). If thrico-logic is unreachable throughout, the
message is still deleted and the server-side 3-hour timeout marks the build failed.

## Cleanup

After every build, whatever the result:

- `security delete-keychain build-<buildId>.keychain` (this also removes it from the keychain search
  list; "not found" is fine for Android builds),
- `rm -rf builds/<buildId>` (source, keys, Firebase configs).

A cleanup problem is reported on a `Cleanup` step; it does not change the build result.

Kept on purpose: `artifacts/<buildId>/` (the built APK/AAB/IPA) and the installed provisioning profile.

## Testing

- `npm run check` runs `src/worker.check.ts`: log batching per step, the 409 cancel, key files and
  permissions, and the bundle mapping. No network, no build.
- End to end without AWS: run a stub of the three `/worker/builds` routes (as thrico-logic's
  `scripts/fake-build-worker.ts` does from the other side), then
  `THRICO_API_URL=http://127.0.0.1:<port> npm start -- --build <id>`.
- Against the real backend: queue a build from the dashboard and run `npm start -- --build <id>`, or
  `npm start` to take it from the queue.

## Known limits

- On a timeout, only the direct child process is killed. Grandchildren (xcodebuild under fastlane)
  can keep running until they finish.
- If the worker is killed with SIGKILL or the Mac loses power, the temporary keychain stays until
  removed by hand (`security delete-keychain build-<id>.keychain`).
- While thrico-logic is unreachable, up to 50,000 log lines are kept in memory; older ones are dropped.

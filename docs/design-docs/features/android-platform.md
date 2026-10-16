# Android Platform Integration

## Context
Tauri 2 on Android has several plugin bugs and WebView limitations that require custom workarounds.

## Decision
Use custom `@JavascriptInterface` in `MainActivity.kt` for file opening instead of `tauri-plugin-opener`. Attach it in Wry's `onWebViewCreate` hook before the initial page load.

## How It Works
- `MainActivity.kt` → `FileOpener` inner class → `@JavascriptInterface` → `FileProvider.getUriForFile` → `Intent.ACTION_VIEW`
- `onWebViewCreate(webView)` injects `AndroidFileOpener` before Wry loads the app page
- `onResume()` idempotently reattaches the same bridge instance after returning from another app
- Frontend validates the bridge with `ping()` and polls for up to 5s before file open
- Downloads go to `/storage/emulated/0/Download/TmuxMobile/`
- Keyboard height via `OnGlobalLayoutListener`, safe area insets via `WindowInsetsCompat`
- Cleartext ws:// enabled via `network_security_config.xml`

## Alternatives Considered
- **tauri-plugin-opener**: Rejected — `openPath()` fails with `OpenArgs` deserialization error on Android
- **View-tree scan/retry from `onCreate`**: Rejected — even after finding the WebView, `addJavascriptInterface` only exposes the object after the next page load, so the current page never sees it

## Trade-offs
- Custom native code to maintain in `MainActivity.kt`
- Depends on Wry's Android `onWebViewCreate` lifecycle hook
- Download-complete Open failures keep the toast available so the user can retry
- `gen/android/` files survive `tauri android init` only if backed up

## Lessons Learned
- NEVER use `tauriOpener.openPath()` on Android — always use `AndroidFileOpener`
- Always check `isAndroid` before falling back to generic Tauri APIs
- `addJavascriptInterface` must run in `onWebViewCreate`; attaching after the initial page load requires a reload before JavaScript can see it
- After changing `tauri.conf.json` identifier, must delete `gen/android/` and run `tauri android init`

## Gradle Configuration Cache vs Tauri's Generated BuildTask.kt

### Context
Gradle 8.11+ enables the configuration cache by default for new projects
(and many developers enable it globally in `~/.gradle/gradle.properties`
for speedup). The configuration cache is a correctness mode: it
serializes all task inputs at configuration time and re-uses them on
subsequent builds, skipping the configuration phase. Under this mode,
accessing `Task.project` from `@TaskAction` (execution time) is
forbidden — `Project` objects don't survive serialization.

Tauri's `tauri android init` generates
`src-tauri/gen/android/buildSrc/src/main/java/<package>/kotlin/BuildTask.kt`
which does exactly that:

```kotlin
@TaskAction
fun assemble() {
    // ...
    project.exec {                     // forbidden
        workingDir(File(project.projectDir, rootDirRel))   // forbidden
        if (project.logger.isEnabled(...)) { ... }         // forbidden
    }
}
```

Result: with config cache enabled, `build:android` fails with

```
Task `:app:rustBuildArm64Release` of type `BuildTask`:
  invocation of 'Task.project' at execution time is unsupported.
```

and Gradle refuses to proceed.

### Decision
Rewrote `BuildTask.kt` in-place to use Gradle's configuration-cache-safe
injection pattern:

```kotlin
open class BuildTask @Inject constructor(
    private val execOps: ExecOperations,
    private val layout: ProjectLayout,
) : DefaultTask() {
    // ...
    @TaskAction
    fun assemble() {
        val projectDir = layout.projectDirectory.asFile
        val taskLogger = logger  // DefaultTask.logger, task-scoped, cache-safe
        execOps.exec {
            workingDir(File(projectDir, rootDirRel))
            // ...
            if (taskLogger.isEnabled(LogLevel.DEBUG)) { args("-vv") }
        }
    }
}
```

`ExecOperations`, `ProjectLayout`, and `DefaultTask.logger` are all
officially supported, cache-safe alternatives. The `RustPlugin.kt`
registration (`tasks.maybeCreate("rustBuild…", BuildTask::class.java)`)
doesn't need to change — Gradle instantiates the task via the
`@Inject` constructor and supplies the services automatically.

### Trade-offs
- Tauri may regenerate this file on `tauri android init --force`. The
  patch then needs to be re-applied. Not expected to happen often.
- Upstream fix (tauri-apps/tauri) would make this workaround
  unnecessary but would also overwrite our version. When syncing
  upstream template changes, verify the generated BuildTask.kt still
  uses the injection pattern before discarding our version.
- Deleting `src-tauri/gen/android/buildSrc/build` and
  `.../buildSrc/.gradle` is required after editing BuildTask.kt to
  force Kotlin recompilation — Gradle sometimes caches stale class
  files from the prior `project.exec` version.
- **Stale configuration-cache entries break the build after toolchain
  updates** (seen 2026-07 after a Kotlin plugin update): Gradle fails at
  configuration time with `Class 'org.jetbrains.kotlin.gradle.plugin.
  internal.CustomPropertiesFileValueSource$Parameters' not found in class
  loader` — the serialized cache references a class from the previous
  Kotlin plugin version. Fix: `rm -rf src-tauri/gen/android/.gradle/
  configuration-cache` (plus the buildSrc caches above) and rebuild. The
  first rebuild re-stores a fresh cache entry; later builds are fast again.

### Alternatives Considered
- **Disable config cache in project `gradle.properties`**: Rejected.
  User-level `~/.gradle/gradle.properties` overrides project-level,
  and Tauri CLI doesn't expose a way to pass
  `--no-configuration-cache` to `gradlew`.
- **Set `org.gradle.configuration-cache.problems=warn`**: Tested and
  works as a quick fix, but the cache then can't actually store
  anything useful — loses the speedup. Also silently accepts whatever
  other config-cache violations Tauri may introduce later.
- **Ask user to change global `~/.gradle/gradle.properties`**:
  Rejected — affects every Gradle project on the machine.

### Lessons Learned
- When a generated-template file is incompatible with a newer Gradle
  feature, prefer patching the generated file in-place (recorded in a
  design doc) over muting the error or changing global config.
- Configuration-cache-safe task pattern: inject `ExecOperations`,
  `ProjectLayout`, `FileSystemOperations`, etc. via `@Inject`; use
  `DefaultTask.logger` instead of `project.logger`.
- Clean `buildSrc/build` and `buildSrc/.gradle` when modifying
  plugin Kotlin — Gradle can run a stale compiled class against
  your updated source.

## Kotlin Gradle Plugin vs Gradle 8.14 Config Cache

### Context
Separate from the `BuildTask.kt` issue above. The generated
`src-tauri/gen/android/build.gradle.kts` pinned the Kotlin Gradle
plugin at **1.9.25** while the wrapper
(`gradle/wrapper/gradle-wrapper.properties`) ships **Gradle 8.14.3**.
Kotlin 1.9.25 only officially supports up to ~Gradle 8.6, and its
plugin internals are incompatible with the configuration cache in
Gradle 8.14. With config cache enabled (the user's global
`~/.gradle/gradle.properties` sets `org.gradle.configuration-cache=true`),
`build:android` fails during the cache fingerprint step with:

```
Could not load the value of field `parameters` of
  ...ConfigurationCacheFingerprint$ValueSource...
> Class 'org.jetbrains.kotlin.gradle.plugin.internal.
  CustomPropertiesFileValueSource$Parameters' not found ...
```

The Rust + frontend stages succeed; only the Gradle assemble step dies.

### Decision
Bumped the Kotlin Gradle plugin to **2.2.0** in
`src-tauri/gen/android/build.gradle.kts`:

```kotlin
classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.2.0")
```

Kotlin 2.2.0 officially supports Gradle 7.6.3–8.14 and is configuration
-cache-clean; it pairs with the existing AGP 8.11.0.

### Why not downgrade Gradle instead
AGP 8.11.0 requires Gradle ≥ 8.13, so the wrapper cannot drop below
8.13. Bumping Kotlin (rather than Gradle) is the only direction that
satisfies both AGP and the config cache.

### Required cleanup after the bump
The first build after editing the plugin version still failed with the
identical error — Gradle was **reusing the stale config-cache entry**
stored by the old 1.9.25 run. Delete the project Gradle state and
rebuild:

```bash
rm -rf src-tauri/gen/android/.gradle \
       src-tauri/gen/android/build \
       src-tauri/gen/android/app/build
```

After that the build succeeds (with only `jvmTarget` deprecation
warnings — Kotlin 2.x wants the `compilerOptions` DSL; non-blocking).

### Alternatives Considered
- **Disable config cache via project `gradle.properties`**: Rejected,
  same reason as the `BuildTask.kt` section — `~/.gradle` (user-level)
  overrides project-level, and Tauri doesn't forward
  `--no-configuration-cache` to `gradlew`.
- **Edit the user's global `~/.gradle/gradle.properties`**: Rejected —
  affects every project on the machine.

## Build Output Location (this machine)

Tauri prints the APK path as the in-project
`src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`.
Where that file PHYSICALLY lands depends on what `app/build` is in the checkout
you build in (measured 2026-10-15 by the validator with two real builds, both in
its own fresh worktree — the second with `app/build` made a symlink into the
cache to reproduce the launch checkout's layout; nothing was built IN the launch
checkout. There is no `~/.gradle/init.d`, environment variable or Gradle config
on this host that relocates anything):

- **A fresh git worktree** (where agents build): `app/build` is a real
  directory, Gradle builds IN-TREE, and the APK is at the in-project path.
  Nothing is written under `~/.cache/builds/gradle-builds`. Two things a fresh
  worktree lacks: **signing** — `key.properties` and `keystore.jks` are
  untracked, so without them Gradle finishes `app-universal-release-unsigned.apk`
  (a different name; the postflight looks for the signed one and exits 1), see
  *Android signing* in `docs/conventions/development.md` — and the
  **environment** below.
- **The launch checkout**: `app/build` is a SYMLINK (dated 2026-08-18) into
  `~/.cache/builds/gradle-builds/android-<hash>/app/`, and Gradle writes
  through it, so the APK is physically in the cache and visible at the
  in-project path. That symlink is the whole "relocation"; it is not an
  environment setting. (`scripts/preflight.mjs` used to describe a global init
  script `00-build-dir.gradle.kts` that is not on this host; its comments were
  corrected on 2026-10-15, behaviour unchanged.)

`npm run build:android` ends with `scripts/preflight.mjs android-apk`: it
re-points an `app/build` SYMLINK that is missing, dangling or stale (pointing at
another checkout), leaves a real directory alone, and exits 0 only when the APK
exists at the in-project path. A bare `npx tauri android build` skips it, which
only matters where `app/build` is a symlink that can be dangling or stale.

The cargo target is NOT relocated — it is the checkout's own `src-tauri/target`
(no `CARGO_TARGET_DIR`, no cargo config on this host; an earlier version of
this note put it in `~/.cache/builds/cargo-target`, which no longer exists
here):

- APK: `<checkout>/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`
  (in the launch checkout that is the cache path above)
- Rust `.so`: `<checkout>/src-tauri/target/aarch64-linux-android/release/libtmux_mobile.so`

To find the freshest APK: in a worktree, `find src-tauri/gen/android/app/build
-name '*.apk' -newermt '-10 minutes'`; in the launch checkout the same command
under `~/.cache/builds` (`find ~/.cache/builds -name '*.apk' ...`) also works,
and misses a worktree build.

## Build Prerequisites (this machine)

- `ANDROID_HOME` (`/home/cfu/Android/sdk`, lowercase `sdk`) and `JAVA_HOME` must
  be set. The agents' environment sets them; a plain shell has neither, and
  `tauri android build` then stops at once with "failed to ensure Android
  environment" (it looks for `~/Android/Sdk`, which does not exist).
- `tauri android build` also needs `NDK_HOME`, which a plain shell may not
  have (the agents' environment sets it). Export the newest installed NDK
  rather than a version typed here — the installed one changes (28.1 when this
  was written, 28.2.13676358 on 2026-10-15, the only one installed):
  `export NDK_HOME="$ANDROID_HOME/ndk/$(ls "$ANDROID_HOME/ndk" | sort -V | tail -1)"`
  (so `ANDROID_HOME` first).
- JDK 17 (`JAVA_HOME` → openjdk@17) and the `aarch64-linux-android`
  rustup target are present.

## The Android compile check is the lib, never the bins (board #378)

`npm run build:android` compiles ONE crate target for the phone: the `[lib]`
(`libtmux_mobile.so`, the cdylib the Gradle `rustBuild` task asks Tauri for).
The three `[[bin]]`s (`tmm`, `server`, the desktop `tmux-mobile`) are host
programs and are never built for Android: a real build leaves only
`libtmux_mobile.{a,rlib,so}` in the cargo target's `aarch64-linux-android/release`
(no bin artifact, in `deps/` either), and the APK's `arm64-v8a/` holds that one
`.so`. So the check that matches the build is
`cargo check` on the lib alone:

```bash
export NDK_HOME="$ANDROID_HOME/ndk/$(ls "$ANDROID_HOME/ndk" | sort -V | tail -1)"
TC="$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin"
CC_aarch64_linux_android="$TC/aarch64-linux-android24-clang" \
AR_aarch64_linux_android="$TC/llvm-ar" \
CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$TC/aarch64-linux-android24-clang" \
  cargo check --manifest-path src-tauri/Cargo.toml --features gui \
    --target aarch64-linux-android --lib
```

Without `--lib`, cargo also checks the bins for Android and fails on main
(`tmm` 28 errors, `server` 1): `chrono` and the desktop-only modules are
compiled out for the target, and those programs use them. Measured 2026-10-15
on main `29277a55`: exit 101 without `--lib`, exit 0 with it (80 warnings, the
desktop-only items that are unused on the phone). The bins are not gated out of
the Android target: nothing builds them there, and a stub `main` per bin would
be scaffolding for a command nobody needs.

Run it when a change touches code the phone compiles — the `backends/` leaf and
anything not behind `cfg(not(any(target_os = "android", target_os = "ios")))`.
The desktop gate (`test:rust`, Linux) never compiles the phone's `cfg` set, so a
desktop-only import in shared code passes it and breaks the first APK (#207).

## The QR scan uses the webview's camera (board #403, 2026-10-16)

On the Android app, "Scan QR code" (the login form and Add server) is the same `ScanDialog` as in a browser: `getUserMedia` in the Tauri webview, decoded by the `qr` library, plus the photo command. There is no native scanner plugin. A first version used `tauri-plugin-barcode-scanner` 2.4.4 and was removed in review (the same day): the pinned plugin cannot give a stop guarantee, and the webview does not need it.

**Why no plugin.** Read in full (`BarcodeScannerPlugin.kt`, 2.4.4): `dismantleCamera` tears down only if `cameraProvider` is already set, and that is assigned inside the asynchronous provider listener, so a cancel that arrives first removes nothing and the listener then binds the camera, on every scan, not only the first. `cancel` clears `savedInvoke` (in `destroy`) before it rejects it, so a cancel never ends the pending `scan()`. A device with no camera, a provider failure and a bind failure never settle or reject it. And the plugin gives JS no "ready" or "stopped" signal, so no JS-side code can guarantee the camera is released. The alternatives were a vendored Kotlin patch that this suite cannot run, or no plugin. The webview already has what the scan needs, and its lifetime is code the tests run.

**What makes the webview camera work.** wry's `RustWebChromeClient.onPermissionRequest` (wry 0.54.2) answers the page's camera request: for `VIDEO_CAPTURE` it asks Android for `CAMERA` and grants the page's request when it is granted. The app serves its pages from `tauri.localhost`, a trustworthy origin, so `navigator.mediaDevices` exists. Our part is the manifest: `uses-permission CAMERA` (prompted by Android, and only when the person taps Scan), and `uses-feature android.hardware.camera.any required=false` so a device without a camera still installs the app (the photo command is the way in there). **Not verified here, the owner's first device check:** that `getUserMedia` actually opens the camera inside the installed app. If it does not, the photo command still reads a picture of the code, and the dialog says why.

**Cost of that choice.** The decode is the JS `qr` library on a frame of at most 720 px, about twenty reads a second, not ML Kit. There is no Google Play services dependency, no camera preview behind the page, no extra permission (the plugin also added `VIBRATE`). The approved "Open settings" command is not offered: a webview has no way to open the app's settings, so a denied camera reads "Camera access is off. Allow it in Android Settings > Apps > tmux-mobile > Permissions", and "Choose a photo" is always there. (Owner ruling on the review.)

**Lifetime.** A scan is one operation (`scan-operation.ts`, `ScanHost`) with an owner, registered in the tap before anything is awaited and distinct from what is on screen. Back, the app going to the background, Cancel, a second tap and the owner form closing each end it, and it ends once; ending releases what it holds. The dialog is keyed by the operation, so a callback can only end its own. The camera gets the dialog's lifetime as an `AbortSignal` and owns the stream from the moment `getUserMedia` resolves: an abort while the request is pending stops the stream that arrives later and never attaches it, an abort while `play()` is pending stops the tracks at once, and a failure after acquisition stops them too.

| step | what happens | pinned by |
|---|---|---|
| request created | `scanQr(owner)` registers the operation in the tap, before any await; a second tap ends the first with nothing | scan-operation.test.ts, App.source.test.ts |
| reason shown | the dialog says what the camera is for before it is asked | ScanDialog.mount.test.ts |
| permission asked | held `getUserMedia`; the operation can end here | App.shell.mount.test.ts "#403: a scan from ..." (7 endings) |
| stream acquired | owned at once; late arrival after the end is stopped, never attached | qr-scan.test.ts, App.shell "#403: a scan from ..." |
| playback ready | an end while `play()` is pending stops the tracks without waiting | qr-scan.test.ts |
| read | one text handed back, camera released, no frame after | ScanDialog.mount.test.ts |
| fallback | "Choose a photo" is reachable in starting, live and failed; a photo gives the tuple and releases the camera | ScanDialog.mount.test.ts |
| Cancel / Back / background | end the operation; the camera is released by the abort | App.shell "#403: a scan from ..." |
| owner teardown | the Add server dialog closing or the login page being replaced ends it | App.shell "#403: a scan from ..." (its form closing), App.source.test.ts |

Promise completion (the scan "ends") and release (the tracks stop) are separate steps in the code and in the tests: every row above asserts the track, not only the dialog.

## Native Notifications (board #72)

`tauri-plugin-notification` is part of the `gui` Cargo feature and registered
in `lib.rs`; the capability is `notification:default`. Nothing in the app's
own `AndroidManifest.xml` changes: the plugin's manifest is merged by the
Tauri gradle plugin and already declares `POST_NOTIFICATIONS`, and the plugin
creates the default notification channel on first use. The webview receives a
`window.Notification` shim from the plugin's init script, so the chat's
notification code (`src/lib/hub/notifications.ts`) needs no plugin import —
see `docs/design-docs/features/notifications.md` for the two shim facts it
has to respect (permission reads `denied` before the first ask; the shim
settles asynchronously). Verified here with the Android compile check above
(the toolchain env it sets — `CC_aarch64_linux_android` etc. — is what
`aws-lc-sys` needs: the NDK clang, which `tauri android build` exports itself).

## Fixed shell elements carry the status-bar inset themselves (board #332)

Owner, 2026-10-09, Android tablet: "左侧 icon 选项卡的侧边栏，以及侧边栏上面的收回按钮，跑到了屏幕最顶端，和消息上面的状态栏重叠了。其他区域顶端的位置好像是正确的".

A tablet in the desktop layout shows the icon rail. `main` reserves the status bar ONCE with `padding-top: var(--sat)` (`--sat` is `env(safe-area-inset-top)`, overridden inline by MainActivity from WindowInsetsCompat). Padding only moves in-flow content. The rail (`.rail`) and the sidebar collapse button (`.shell-side-toggle`) are `position: fixed`, so they ignored it and started at the top of the screen. Each now adds the inset itself: `.rail { top: var(--sat) }`, the toggle's `top: calc(var(--sat) + …)`, and the scratch terminal docked left (`.scratch.left { top: var(--sat, 0px) }`, validator's P1: it renders under the same desktop-layout condition, its 36 px head sat under the bar). The bottom-docked scratch panel needs none: its height is capped at 100vh − 80px. On a desktop `--sat` is 0, so nothing moves there. The bottom-anchored `.sys-sidebar` and the full-screen dialog backdrops need no inset. Known and left alone: `menuPlacement` clamps a popover 8 px from the viewport top, not from `--sat`, so a very tall popover flipped above its anchor (the server menu with many servers) could start under the bar; none reaches that height at tablet sizes today. The side sheet already pads with `--sat`.

Measured in the browser harness at 1280×800, desktop layout, touch, `--sat: 24px` (this machine has no Android emulator image). Before: rail top 0, collapse button top −1, page head and sidebar top 24. After: rail top 24 (brand 34), collapse button 23 (centred on the 24 px-down page-head row), page head and sidebar unchanged at 24. `App.source.test.ts` pins both insets and `main`'s.

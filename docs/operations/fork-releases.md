# Fork Releases

The public fork publishes its own server and macOS desktop artifacts from `fork-main`. The workflow
uses standard GitHub-hosted `ubuntu-24.04` and `macos-15` runners and does not depend on upstream
release credentials or third-party runners.

Each push to `fork-main`, or a manual **Fork release** workflow dispatch, creates a version named
`0.1.<workflow run number>` and publishes:

- `t3-<version>.tgz`, used whenever a client needs that exact server version
- `t3-latest.tgz`, used for initial installs and background-service management
- arm64 and x64 macOS desktop DMGs and ZIPs, their blockmaps, and a merged `latest-mac.yml`

The desktop build embeds `matheustimbo/t3code` as its update repository. The in-app update button,
desktop update checks, copied server commands, background-service updates, SSH bootstrapping, WSL
runtimes, and model manifest all resolve from the fork rather than the upstream package or release
feed.

The macOS artifact is ad-hoc signed because the fork has no Apple Developer ID credentials. macOS
may require the user to approve the first installation in Privacy & Security. Add Developer ID
credentials and switch the workflow to `--signed` if trusted public distribution is needed later.

The fork's **Fork mobile builds** workflow builds mobile apps directly on standard GitHub-hosted
runners without EAS:

- Android produces an arm64 release APK signed with Expo's development key. It is intended for
  personal sideloading on modern Android phones, not store distribution. The `ANDROID_PACKAGE`
  repository variable can override the fork's default `com.matheustimbo.t3code.fork` package name.
- iOS always produces an unsigned arm64 Simulator `.app` archive. A signed IPA for registered
  iPhones is also produced when `IOS_TEAM_ID` and the signing secrets below are configured. The
  optional `IOS_BUNDLE_ID` repository variable defaults to `com.matheustimbo.t3code.fork`.

The iPhone build uses the reduced-capability Personal Team mode, which omits the widget and share
extensions, push, associated domains, and native Sign in with Apple entitlements. Configure:

- repository variable `IOS_TEAM_ID`
- secret `IOS_CERTIFICATE_BASE64`, containing a base64-encoded Apple Development `.p12`
- secret `IOS_CERTIFICATE_PASSWORD`
- secret `IOS_PROVISIONING_PROFILE_BASE64`, containing a base64-encoded iOS development profile
  whose App ID matches `IOS_BUNDLE_ID` and whose device list contains the target iPhone

The upstream Release, Mobile EAS Production, and Deploy T3 Connect relay workflows remain disabled
in the fork repository settings. Mobile Expo updates are off unless a build supplies its own
`T3CODE_EAS_PROJECT_ID` and optional `T3CODE_EAS_OWNER`.

## Upstream synchronization

The **Sync upstream fork** workflow runs daily and can also be dispatched manually. It first mirrors
`pingdotgg/t3code:main` into the fork's `main` branch, then merges that branch into `fork-main` when
Git reports no conflicts. A successful integration explicitly dispatches the fork release because
GitHub does not start additional workflows for ordinary pushes made with `GITHUB_TOKEN`; mobile
builds are dispatched only when mobile or shared runtime paths changed.

When the automatic merge conflicts, the workflow leaves `fork-main` untouched and opens one pull
request from `main` instead. Resolve that PR manually while preserving the fork-only ticket-title,
update-channel, and build behavior.

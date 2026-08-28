# Fork Releases

The public fork publishes its own server and macOS desktop artifacts from `fork-main`. The workflow
uses standard GitHub-hosted `ubuntu-24.04` and `macos-15` runners and does not depend on upstream
release credentials or third-party runners.

Each push to `fork-main`, or a manual **Fork release** workflow dispatch, creates a version named
`0.1.<workflow run number>` and publishes:

- `t3-<version>.tgz`, used whenever a client needs that exact server version
- `t3-latest.tgz`, used for initial installs and background-service management
- a universal macOS desktop DMG and ZIP, their blockmaps, and `latest-mac.yml`

The desktop build embeds `matheustimbo/t3code` as its update repository. The in-app update button,
desktop update checks, copied server commands, background-service updates, SSH bootstrapping, WSL
runtimes, and model manifest all resolve from the fork rather than the upstream package or release
feed.

The macOS artifact is ad-hoc signed because the fork has no Apple Developer ID credentials. macOS
may require the user to approve the first installation in Privacy & Security. Add Developer ID
credentials and switch the workflow to `--signed` if trusted public distribution is needed later.

The upstream Release, Mobile EAS Production, and Deploy T3 Connect relay workflows are disabled in
the fork repository settings. Mobile Expo updates are off unless the build supplies its own
`T3CODE_EAS_PROJECT_ID` and optional `T3CODE_EAS_OWNER`.

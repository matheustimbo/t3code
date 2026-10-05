# Install T3 Code

T3 Code runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

The CLI is a self-contained executable. It does not need Node.js, npm, or a
compiler. The native desktop app includes the same server runtime.

You need an installed, authenticated provider before starting a thread. You can
launch T3 Code and configure providers afterwards.

## Command line

```bash
curl -fsSL https://raw.githubusercontent.com/matheustimbo/t3code/fork-main/scripts/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/matheustimbo/t3code/fork-main/scripts/install.ps1 | iex
```

This puts `t3` in `~/.local/bin`. If your shell reports `command not found`
afterwards, that directory is not on your `PATH` yet; the installer prints the
line to add. Set `T3CODE_CHANNEL=nightly` to install the nightly train, or
`T3CODE_VERSION` to pin an exact version.

| Task                                             | Command                                                   |
| ------------------------------------------------ | --------------------------------------------------------- |
| Start the server and open the web app            | `t3`                                                      |
| Start the server without a browser               | `t3 serve`                                                |
| Keep it running in the background (macOS, Linux) | `t3 service install` ([details](./background-service.md)) |
| Move to the newest release                       | `t3 update`                                               |
| Remove it again                                  | `t3 uninstall`                                            |

Run `t3 help` or `t3 --help` for the full reference. To start in a new working
directory, use an explicit path such as `t3 ./my-project`. A bare directory name
is accepted only if it already exists.

If `t3` or `t3 start` reports an already running server, connect to that server
instead. Stop it before starting a replacement, or use a different `--base-dir`
for an independent server.

### Use a server from scripts

`t3 project list` and `t3 thread list/create/send/status/wait` connect to an
explicit server without opening an app or reading desktop credentials. Supply a
dedicated, short-lived bearer credential through an inherited regular-file descriptor; there
is no token argument, environment-variable fallback, automatic pairing or saved
session. HTTPS is required except on loopback. Redirects are rejected.
With `--json`, command data and remote errors stay on stdout as JSON; text errors
go to stderr. Failures return a nonzero exit code.

Have the environment owner supply the credential through an approved secret
manager or a protected file. Reads need `orchestration:read`. Executing a
mutation also needs `orchestration:operate`; neither terminal nor access
administration scopes are needed; credentials with other scopes are rejected.
Do not use an administrative desktop session. Cookie and DPoP sessions are not
supported by this CLI.
Local session issuance requires an explicit `--scope` for each permission, for
example `t3 auth session issue --scope orchestration:read --ttl 10m`. It does not
add administrative permissions. Capture the credential privately; never paste it
into a chat or command argument. Session issuance writes access state on the host.

These are environment-wide scopes. Selecting a project or thread in the CLI is
a client check, not a server-enforced allowlist or filesystem sandbox. Provider
permissions and the server machine's actual isolation still apply.

Use an already supplied credential file in these examples; the commands do not
issue credentials. Each invocation opens its descriptor afresh:

```bash
t3 project list --server https://your-host.example --token-fd 3 --json 3<"$CREDENTIAL_FILE"
t3 thread list --server https://your-host.example --token-fd 3 --project PROJECT_ID --json 3<"$CREDENTIAL_FILE"
```

Copy the environment ID and exact workspace directory from the returned data.
Creation previews an empty conversation in the project's current checkout,
using its default model and `approval-required` permissions. It does not create
a worktree or start a provider. If the project has no default model, add both
`--instance` and `--model`. Append `--execute` only after reviewing the preview:

```bash
t3 thread create --server https://your-host.example --token-fd 3 \
  --environment-id ENVIRONMENT_ID --project PROJECT_ID --workspace /server/project \
  --title "Review the change" --json 3<"$CREDENTIAL_FILE"
```

`send` reads the prompt from a UTF-8 file, previews without exposing its contents,
and requires the exact thread permissions and working directory. Add `--execute`
to start provider work. It refuses busy or archived threads and pending decisions;
it does not steer work, approve requests or change permissions.

```bash
t3 thread send THREAD_ID --server https://your-host.example --token-fd 3 \
  --environment-id ENVIRONMENT_ID --project PROJECT_ID --workspace /server/project \
  --runtime-mode approval-required --prompt-file ./prompt.txt --json 3<"$CREDENTIAL_FILE"
t3 thread status THREAD_ID --server https://your-host.example --token-fd 3 \
  --project PROJECT_ID --json 3<"$CREDENTIAL_FILE"
```

A dispatch receipt confirms acceptance, not provider success. Copy the `messageId`
returned by an executed `send` and follow that message, including the interval
before the provider starts a turn:

```bash
t3 thread wait THREAD_ID --server https://your-host.example --token-fd 3 \
  --project PROJECT_ID --message-id MESSAGE_ID --timeout-seconds 300 --json \
  3<"$CREDENTIAL_FILE" >result.json &
```

Use `status --message-id MESSAGE_ID` to read that request's status and output.
An earlier completed turn is never used as its result. `wait --turn-id TURN_ID`
also follows an exact latest turn ID obtained separately from `status`.

Execution requires a server that advertises atomic thread command preconditions.
If any environment event occurs after the CLI's checks, the server rejects the
mutation. Read and review the new state before submitting again; the CLI does not
retry mutations. Guarded creation is supported in project checkouts, and refuses
automatic Scratch folder creation and worktree bootstrap.

Wait polls once per second, stops for completion, interruption, error or a pending
decision, and keeps waiting while native background work is reported. Older
servers may omit background liveness; their turn completion does not establish
that all background agents stopped. Its JSON
`waitState` distinguishes those outcomes. A timeout or killing the local wait
process does not cancel server work. If an exact turn ceases to be latest, wait
fails. A message that never becomes the latest correlated turn times out instead
of returning another turn's result. Message correlation requires an updated
server. `status` reads a one-turn window when
the server supports it; older servers may return more history. The CLI displays
only assistant messages for the selected turn. Changed snapshot versions are
rejected by `status` and read again by `wait`. After an uncertain transport
failure, inspect status before deciding whether to send again.

### Intel Macs

There is no `t3` executable for Intel Macs (the desktop app is available). To
run a server there, build it from source with Node.js 24 and `vp`
([Install vp](https://github.com/pingdotgg/t3code#install-vp)):

```bash
git clone https://github.com/pingdotgg/t3code
cd t3code && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

`t3 update` and the background service do not apply to a server run this way;
update it with `git pull` and a rebuild.

## Desktop app

Download a release from
[this fork's GitHub Releases](https://github.com/matheustimbo/t3code/releases).

The package managers below install the upstream build, not this fork. Use the release above when you
want ticket-derived thread titles and this fork's updates.

| Platform           | Install                            |
| ------------------ | ---------------------------------- |
| Windows            | `winget install T3Tools.T3Code`    |
| macOS              | `brew install --cask t3-code`      |
| Debian, Ubuntu     | `sudo apt install ./T3-Code-*.deb` |
| Arch Linux         | `yay -S t3code-bin`                |
| Arch Linux nightly | `yay -S t3code-nightly-bin`        |

The `.deb` updates itself like the other desktop builds. It asks for your
password to install each update. If your desktop has no password prompt, the
update fails. Download the new `.deb` and install it the same way.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install the provider CLIs inside that distro. T3 Code installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Open a project from a terminal

Install the CLI, then run this command with the desktop app open on the same
machine:

```bash
t3 app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `t3 app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Mobile app

Install T3 Code from the
[App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or
[Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code).
The phone connects to a server on another machine. Follow
[remote access](./remote-access.md) to link it through T3 Connect or a pairing URL.

Nightly builds need the beta app. The store apps cannot connect to them. A Nightly build also
shows these links as QR codes in **Settings → General → Mobile app**.

- **iPhone and iPad:** join the [TestFlight beta](https://testflight.apple.com/join/XgaxaRtd).
- **Android:** join the [beta group](https://groups.google.com/g/t3-code-v2-beta). With the same
  Google account, open the [Google Play testing page](https://play.google.com/apps/testing/com.t3tools.t3code)
  and become a tester.

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from T3 Code's provider settings.                                                                                         |
| Pi          | Install [Pi](https://pi.dev), then run `pi` once to finish its login or API-key setup.                                                                    |

Provider CLIs must be on the server's `PATH`. If T3 Code cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

T3 Code warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or the
CLI's own update command when T3 Code cannot tell. Update a CLI installed with
mise through mise. Cursor and Antigravity update with T3 Code. Homebrew installs
compare against the version Homebrew offers, which can trail the npm release by
a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, T3 Code does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), and [Pi](./providers-pi.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating T3 Code](./updating.md): update the app and connected servers.

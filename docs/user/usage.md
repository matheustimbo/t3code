# Review usage and plan limits

## Plan limits

The **Plan limits** tab shows the subscription allowance reported by each configured provider. It
lists every reported reset window, puts the window with the least remaining allowance first, and
keeps exhausted providers selectable. The same limits also appear in provider settings and the
model picker.

Limits stay grouped by environment and account. T3 Code never adds percentages from different
environments together. When two environments report the same authenticated account identity, the
page marks them as the same account but still shows both readings separately.

Codex plan limits use the official Codex app-server and are available automatically. The other
native integrations are experimental and off by default:

- **Claude** reads the local Claude OAuth session and falls back to Claude Code's structured
  `/usage` data.
- **Cursor** reads the local Cursor session through Cursor's dashboard API.
- **Grok** uses the optional `x.ai/billing` CLI capability.
- **OpenCode** reports OpenCode Go windows when `OPENCODE_GO_API_KEY` or `OPENCODE_API_KEY` is
  available to that provider instance.

Enable an experimental integration from that provider's settings. Credentials are read only on
the environment that owns them; T3 Code does not persist them in usage snapshots, log them, or send
them to clients. Private provider APIs can change without notice, so an experimental source may
temporarily show **Unavailable** until the integration is updated.

### CLIProxyAPI account pools

T3 Code can enumerate and read the independent OAuth accounts managed by CLIProxyAPI for **Claude**,
**Codex**, and **Grok/xAI**. Add these variables to each matching provider instance:

```text
CLIPROXYAPI_MANAGEMENT_URL     http://127.0.0.1:8317
CLIPROXYAPI_MANAGEMENT_KEY     your-management-key            Sensitive
```

Claude and Grok still require **Experimental plan limits** to be enabled. Codex switches from its
single app-server reading to the CLIProxyAPI account pool whenever the management key is configured.
Each credential is shown separately; percentages are never added across the pool. Disabled and
failed credentials remain visible with their own status. Claude accounts also show the plan
reported by the account profile and include modern model-scoped weekly windows such as Fable.

The management URL can be omitted when the provider already has a CLIProxyAPI base URL in
`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `CODEX_BASE_URL`, `XAI_BASE_URL`, or `GROK_BASE_URL`.
Setting it explicitly is recommended, especially behind a reverse proxy. The management API must be
enabled and reachable from the T3 Code server.

CLIProxyAPI does not currently expose equivalent quota adapters for T3 Code's **Cursor** or
**OpenCode** providers, so those two continue to use their native readers. CLIProxyAPI's Kimi and
Antigravity account types are not shown because T3 Code has no corresponding built-in provider.

The management key authorizes account inventory and authenticated upstream calls. Keep it sensitive;
T3 Code uses it only on the server and never includes it in usage snapshots sent to clients. For
Grok paid accounts whose billing endpoints do not return quota windows, T3 Code reports the account
as unavailable instead of sending a model request as a health probe.

T3 Code refreshes limits only while provider status is in demand and respects the environment's
background-activity policy. A failed refresh keeps the last successful values marked **Out of
date**. Once a stale window's reset time has passed, T3 Code hides its old percentage instead of
presenting it as current.

## Local usage

The **Local usage** tab combines Codex, Claude Code, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown in this tab.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.

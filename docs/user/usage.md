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

A CLIProxyAPI hub pools several OAuth accounts behind one endpoint. T3 Code can show each pooled
account's plan limits beside your local ones.

Add the hub under **Settings → Providers → Usage providers → Add hub**, giving its URL and
management key. Every **Claude** and **Codex** account the hub pools then appears on
**Usage → Limits** under the hub's name, badged _via CLIProxyAPI_ so a pooled account is not
mistaken for the local login. Each account keeps its own reset windows; percentages are never added
across the pool. An account whose credential has expired is left out rather than shown at zero.

The hub reports no usage percentages itself, so T3 Code asks each provider through the account's own
credential. That means the numbers match what the provider would tell that account directly.

**Grok/xAI** pooled accounts work differently: add these variables to the Grok provider instance
instead, and enable **Experimental plan limits** in the same settings.

```text
CLIPROXYAPI_MANAGEMENT_URL     http://127.0.0.1:8317
CLIPROXYAPI_MANAGEMENT_KEY     your-management-key            Sensitive
```

The management URL can be omitted when the provider already has a CLIProxyAPI base URL in
`XAI_BASE_URL` or `GROK_BASE_URL`. Setting it explicitly is recommended, especially behind a reverse
proxy.

**Cursor** and **OpenCode** read their limits natively and do not go through a hub. CLIProxyAPI's
Kimi and Antigravity account types are not shown because T3 Code has no corresponding provider.

The management API must be enabled in CLIProxyAPI and reachable from the environment running the T3
Code server. The management key authorizes account inventory and authenticated upstream calls. Keep
it sensitive: T3 Code stores it in the environment's secret store, uses it only on the server, and
never includes it in usage snapshots sent to clients.

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

The **Limits** view shows how much of each subscription window you have used on Codex and Claude
Code, per connected environment: the session and weekly windows, plus a per-model weekly window
such as Fable when your plan has one. Each window is a bar from the moment it opened to its reset,
filled by the share of quota spent; a thin line marks how far into the window you are, which is
also where even spending would have put the fill, and the icon beside the label says whether you
are ahead of, on, or under that pace. Hover a bar for the exact reset time. Limits refresh on the
provider health-check interval and update live while a turn runs. API-key accounts have no
subscription windows and say so; that includes a Claude Code that reaches Anthropic through a proxy
via `ANTHROPIC_AUTH_TOKEN`, since the CLI then treats itself as an API-key client.

If you pool accounts behind a CLIProxyAPI hub, open **Settings → Providers → Usage providers**
and choose **Add hub**. Select the device that should connect to the hub; its accounts appear on
the Limits view. Remove hubs from the same settings section. Each limits row shows its provider
and instance name, or a small _CLI Proxy_ label for
hub accounts. When a connected provider reports limits for the same provider and email, its row
replaces the hub copy, keeping details such as banked reset credits. The hub copy remains visible
if the connected provider cannot report limits. Enter the hub's URL and management key; the key
is stored on the server and never sent back to a client. Emails are blurred until clicked, as in
provider settings.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart. Refreshing rescans every connected environment and refetches model pricing on
each of them, so a newly released model that showed $0.00 gets a price without waiting for the daily
pricing update.

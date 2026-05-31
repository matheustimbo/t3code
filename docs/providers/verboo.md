# Verboo

Verboo is a Claude Code–compatible agent CLI. In T3 Code it works just like the Claude provider:
T3 Code drives the `verboo` binary, and the binary owns its own login and account state under
`~/.verboo`.

This guide is for people who want to use one or more Verboo setups in T3 Code.

## I Only Use One Verboo Account

Use the default provider.

Log in with Verboo normally:

```bash
verboo
```

Complete the account (OAuth) login flow that the `verboo` CLI starts. In T3 Code Settings, your
Verboo provider can stay like this:

```text
Display name: Verboo
Binary path: verboo
Verboo HOME path: empty
```

An empty `Verboo HOME path` means T3 Code uses your normal home directory, so the `verboo` binary
reads its config and account from `~/.verboo`.

## Which Models Are Available?

Verboo models are discovered at runtime — T3 Code asks the `verboo` binary which models your account
can use, so the model list reflects whatever Verboo currently offers (model slugs look like
`growth/qwen3.6-27b`).

If discovery can't reach Verboo (offline, not logged in, etc.), T3 Code falls back to a seed model
plus any models you added under the provider's custom models. You can always add extra model slugs
in the provider's settings.

## I Want Work And Personal Verboo Accounts

Use a different home for each account, exactly like the Claude multi-account setup.

### Set Up The First Account

Log in normally and keep `Verboo HOME path` empty:

```text
Display name: Verboo Work
Binary path: verboo
Verboo HOME path: empty
```

### Set Up The Second Account

Log in with a separate home, then add another Verboo provider pointing at it:

```bash
mkdir -p ~/.verboo_personal_home
HOME=~/.verboo_personal_home verboo
```

```text
Display name: Verboo Personal
Binary path: verboo
Verboo HOME path: ~/.verboo_personal_home
```

A custom `Verboo HOME path` keeps each account's `.verboo` directory isolated. Use the email shown
in Settings to confirm each provider is using the intended account.

## Can I Switch Verboo Accounts In An Existing Thread?

Usually, no. As with Claude, T3 Code only offers Verboo providers that use the same home for an
existing thread — a different home is treated as a different environment.

## Notes

- Authentication is handled by the `verboo` binary (account / OAuth login), not by T3 Code.
- Do not put environment variable assignments in `Launch arguments`; use the Environment variables
  section instead.

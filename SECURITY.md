# Security policy

## Supported versions

Fixes land on the latest release line only. Self-hosted installs get them with
`relay update` (see [docs/self-hosting.md](docs/self-hosting.md)).

| Version | Supported |
|---|---|
| 2.x | yes |
| < 2.0 | no |

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately
through GitHub: **Security → Report a vulnerability** on
[frizzonje/relay](https://github.com/frizzonje/relay/security/advisories/new).

A useful report says which version and which part (web, api, media server,
desktop client) is affected, how to reproduce it, and what an attacker gains.
You will get an answer within a week; once a fix is released, the advisory is
published with credit to you unless you ask otherwise.

## Scope

In scope: anything that lets someone read, write or join what their access
should not allow — channels and servers behind a password, direct messages,
calls, the owner panel, uploads — or that bypasses bans, rate limits or the
site password. The trust model is described in
[docs/architecture.md](docs/architecture.md) and [docs/protocol.md](docs/protocol.md).

Out of scope: denial of service by sheer traffic volume (that is the job of
whatever sits in front of the server), and findings that need the owner's own
shell access to the machine.

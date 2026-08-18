# Changelog

Written for the person who runs a relay server, not for the person who wrote
it: every entry says what changes on your machine and for the people using it.
Releases before 1.0.0 are on the [releases page](https://github.com/frizzonje/relay/releases) —
reconstructing notes for them after the fact would be invention, not history.

## 1.0.0 — unreleased

Two things carry this release, and everything else in it exists because those
two unlocked it: **the conversation stops evaporating**, and **a person is a
key rather than a string in a browser**.

### Upgrading from 0.x — read this first

A 1.0 server needs a database that a 0.x stack has no way to start, so the
upgrade is a deliberate act rather than a side effect of pulling images:

- **`:latest` does not move to 1.0.** A server on 0.x keeps running 0.x until
  its owner decides otherwise. This matters because installations follow
  `:latest` and pull on every `relay up` — moving it would have taken the fleet
  down with a command that had always been safe.
- **The way up is re-running `install.sh`.** It recognises an installation that
  predates the database, says what changes for the people using it, takes a
  full backup, and asks — before a single file moves. The rollback is two
  commands, printed on the same screen.
- **Everyone picks a name once more.** Names used to live in the browser; they
  now belong to a key. Servers, channels, uploaded files and certificates stay
  exactly where they are.
- **`registry.json` is left untouched.** Servers and channels migrate into
  Postgres on first start, and a `registry.migrated` marker is written beside
  the original — that file is the price of being able to go back.

New requirements: a `db` service in the stack, `POSTGRES_PASSWORD` in `.env`
(generated for you), and roughly 3 GB of disk. A 1 GB / 1 core VM is still
enough; give it 2 GB of swap.

### Added

- **History that survives a restart.** Messages, attachments and the server
  registry live in Postgres. The feed pages upward instead of arriving as one
  snapshot, and a file lives exactly as long as the message that carried it.
- **Retention with a promise attached.** `RETENTION_DAYS`, 14 by default;
  `0`/`forever` keeps everything, `ephemeral` keeps nothing, and api says which
  one is in force, in words, in its log on every start.
- **Identity on keys.** Each device generates an Ed25519 pair; the private key
  never leaves it. Login is challenge-response behind the shared site password.
  Devices form a tree — an existing device signs in a new one over QR — and any
  of them can be revoked.
- **A face for every key.** An identicon derived from the key's fingerprint,
  which is what tells two people with the same nickname apart.
- **An owner for the installation.** `install.sh` prints a one-time link; who
  opens it binds their key as owner. `relay owner-link` reissues it from the
  server, and that is the only path back to power.
- **Roles and moderation.** Deliberately two: `owner` and `banned`. A ban takes
  effect under live sockets rather than at next login, and comes in two scopes —
  off one server, or off the installation. The banned person gets a screen with
  a reason rather than an app that has gone quiet.
- **Search over history.** Full-text across a channel or a whole server
  (Ctrl/⌘ + F); a result opens in its own channel, surrounded by context.
- **Mentions that mean someone.** `@name` carries a key, so a rename never
  breaks it. The named person gets a counter, a sound even in a silenced
  channel, and the message highlighted when they open it.
- **Pinned messages** — the single exception to retention, and an explicit one.
- **About in settings** — client and server versions side by side, with a
  warning when the tab is running older code than the server.
- **`relay backup` and `relay restore`** understand the database, including on
  a stack that does not have one yet.

### Changed

- **Unread marks, channel sound and per-person volumes moved to your identity.**
  Read it on the desktop, and it is read on the phone. The settings section that
  used to say "across devices" is gone: it now simply is.
- **A new name reaches every device you are signed in from**, not just the one
  that typed it.
- **Renaming and deleting is tied to a key**, not to whichever browser created
  the entry.

### Fixed

- Leaving an SFU channel no longer leaves the server thinking you are still on
  the media server — a healthy direct call looked split, and everyone in it got
  told they could not be heard.
- Switching a channel to the transport a client is already on no longer rebuilds
  its connections, which used to cost seconds of silence to the one person the
  switch was meant to help.

### Not in this release

End-to-end encryption and private messages. Neither was forgotten: the
reasoning for both is written down in [docs/plans/relay-1.0.md](docs/plans/relay-1.0.md)
and [docs/plans/relay-2.0.md](docs/plans/relay-2.0.md). What is and is not
encrypted today is in the [README](README.md#privacy-and-encryption).

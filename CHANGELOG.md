# Changelog

Written for the person who runs a relay server, not for the person who wrote
it: every entry says what changes on your machine and for the people using it.
Releases before 1.0.0 are on the [releases page](https://github.com/frizzonje/relay/releases) —
reconstructing notes for them after the fact would be invention, not history.

## 1.0.0 — 2026-08-21

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

- **Servers and channels have room for everyone.** The ceilings used to be
  installation-wide — twenty servers, fifty channels — so one enthusiastic
  person filled them and nobody could create anything again. Now each person
  gets five servers and each server twenty-five channels, under a much higher
  ceiling that exists to protect the machine.
- **A refused create says why.** Creating a server or a channel used to fail in
  silence: the dialog closed, the rail switched to a server that was never
  made. It now answers, and running out of your own five reads differently from
  running out of the installation's — only one of those is yours to fix.
- **A channel name on one server no longer takes it from every other.** Channel
  addresses now carry a mark of their own server, so "общий" is free on yours
  no matter who used it first. Nobody sees the mark; a channel goes by its name.
- **A client too old for the server is told so.** The contract has a version
  checked at the handshake, and the app says whether it is the app or the
  server that is behind — the two need opposite fixes.
- **Unread marks, channel sound and per-person volumes moved to your identity.**
  Read it on the desktop, and it is read on the phone. The settings section that
  used to say "across devices" is gone: it now simply is.
- **A new name reaches every device you are signed in from**, not just the one
  that typed it.
- **Renaming and deleting is tied to a key**, not to whichever browser created
  the entry.
- **The TURN relay stops handing out a password that never expires.** Every
  person who logged in was given the same relay credentials, in the clear, and
  they worked forever — including for someone who had long since stopped being
  a user of your relay, and whose only way out was changing `.env` and cutting
  everyone's calls at once. Credentials are now signed, one per browser, and
  valid for a day (`TURN_SECRET`, `TURN_TTL_SECONDS`). `install.sh` generates
  the key; nobody ever types it and it never leaves the server. A hand-written
  `.env` with the old `TURN_USERNAME`/`TURN_CREDENTIAL` pair keeps working as
  before — that is what somebody else's relay server looks like.

### Fixed

- **`relay update` works again.** It asked GitHub for the newest release and
  got back the desktop app's — the two are released from the same repository —
  and then died trying to fetch a server stack out of it. It reads version tags
  now, and so does `install.sh`, which had been quietly falling back to
  `:latest` on every fresh install instead of pinning the release it installed.
- **The password to a locked server no longer sits in your browser.** It was
  kept there so the server would still be open to you after a reconnect; a
  signed pass does that now. It is not your secret either — it is the one
  shared by everyone who visits that server.
- **Reactions belong to a key, not to a name.** Names here are free and repeat;
  taking someone else's used to mean taking their reaction with it.
- Leaving an SFU channel no longer leaves the server thinking you are still on
  the media server — a healthy direct call looked split, and everyone in it got
  told they could not be heard.
- Switching a channel to the transport a client is already on no longer rebuilds
  its connections, which used to cost seconds of silence to the one person the
  switch was meant to help.

### The desktop client

Released alongside, from this same repository, as
[`desktop-v1.0.0`](https://github.com/frizzonje/relay/releases/tag/desktop-v1.0.0):
one version number now covers the app, the images and the packages. Its own
notes are on that page — the short version is that on the desktop your key is
created and kept outside the browser engine, in the system's own store, because
the browser path for it does not work there.

### Not in this release

End-to-end encryption and private messages. Neither was forgotten: the
reasoning for both is written down in [docs/plans/relay-1.0.md](docs/plans/relay-1.0.md)
and [docs/plans/relay-2.0.md](docs/plans/relay-2.0.md). What is and is not
encrypted today is in the [README](README.md#privacy-and-encryption).

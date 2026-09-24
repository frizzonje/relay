# Changelog

Written for the person who runs a relay server, not for the person who wrote
it: every entry says what changes on your machine and for the people using it.
Releases before 1.0.0 are on the [releases page](https://github.com/frizzonje/relay/releases) —
reconstructing notes for them after the fact would be invention, not history.

## Unreleased

### Fixed

- **A screen share in a room of three no longer leaves everyone mute.** Any
  rebuild of the media-server connection — a reconnect, a recovery step —
  used to switch off your own microphone and screen without a word, so the
  next attempt to send them failed and the room went silent until everyone
  left and came back. Your devices now survive the rebuild.
- **A call through the media server recovers on its own.** A reconnect that
  was cut short could leave the next one without its watchdog: stuck on
  "connecting" in silence, with nothing left to notice it.
- **Two people entering an empty media-server room at once hear each other.**
  The media server could open the room twice, once for each of them, and
  leave them in the same channel on two separate switchboards. That is exactly
  how a whole room comes back after the media server restarts.

### Changed

- **A media-server channel calls only through the media server.** When the
  server fails, the channel no longer falls back to direct calls — that
  fallback moved people one by one, split the room across two ways of calling
  that cannot hear each other, and caused the silence above. The channel now
  says the server is unavailable and reconnects by itself as soon as it is
  back. A direct channel stays direct, and an installation with no media
  server configured at all still calls directly in every channel.
- **The "Hold on to the media server from (people)" setting is gone.** It
  chose when to fall back to direct calls, and there is no fallback any more.
  A value saved for it is ignored, with a warning in the api log.

### Security

- **Next.js 15.5.26, multer 2.4, sharp 0.35.4 and qs 6.16.** Closes the
  published advisories against what the server runs, among them a critical
  one in Next.js image optimization and denial-of-service ones in upload
  handling.

## 2.0.0 — 2026-09-08

Two things carry this release, and both change who an address can name: **a
conversation can be with one person instead of a room**, and **that person can
be called, not just met in a channel**. The third follows from the two: **the
installation is now set up from a panel, not from `.env`** — a server where
strangers can reach your people needs an owner with the off switch within
reach, and the panel is that switch, for this release and the ones after it.

### Upgrading from 1.x — read this first

The machinery was built in 1.0, so this time the upgrade asks before it moves
instead of requiring a reinstall:

- **`:latest` does not move to 2.0.** Nothing about a running stack changes by
  itself. The way up is `relay update`, which sees a major, says so, takes a
  full backup first and asks — before a single file moves. The rollback is the
  two commands it prints.
- **No new services and no new required variables.** The database gains three
  tables (direct messages, settings, call marks), and api creates them itself
  on the first start after the upgrade.
- **The settings table starts from your `.env`, then stops reading it.** On
  the first start with an empty settings table, `RETENTION_DAYS` and
  `UPLOAD_MAX_TOTAL_BYTES` are read once and become the values in the panel;
  from then on the panel rules and those lines change nothing. `SITE_PASSWORD`
  stays a fallback: a password set in the panel wins over the file.
- **The owner stays the owner.** The identity bound in 1.0 keeps the panel. If
  nobody ever claimed ownership, `relay owner-link` prints the one-time link
  that binds it now — and only that person sees the panel.

### Added

- **Direct messages.** A conversation with a person, not a room: addressed to
  an identity, listed in its own section next to the servers, kept by the same
  rules as everything else — same history, same retention, same file limits.
  Names are not unique, so every list of people shows the identicon and a
  short fingerprint, and presence tells whether the person is there to read
  it. Anyone who passed the site password can start one; guests cannot, and a
  ban closes the door on both channels and conversations. One thing is said
  where people make the decision rather than hidden in a corner: a direct
  message is addressed to one person, but it is not hidden from the
  installation's owner.
- **Presence that covers the whole installation.** Online, in a call, or away —
  the same dot everywhere a person is shown, across all devices, not just
  inside a voice channel.
- **Calling a person.** From a conversation, a call rings the other side with
  accept and decline — a corner toast, not a takeover: the person can keep
  working. The ring runs 45 seconds by default (10–180, a panel setting). If
  the person is already speaking in a voice channel, the caller hears busy
  rather than silence; if no device is connected at all, the refusal is
  immediate. No answer leaves a mark in the conversation with a one-tap call
  back, and a wrong number is a wrong number — `offline` and `no-answer` read
  differently. A call is answered per person, not per tab: it rings on every
  device, and answering one silences the rest. The conversation itself is
  always a direct connection between the two — never the media server — and
  it survives a few seconds of dropped network (24 s, like a voice channel).
  Video is asked for while dialing, so the person being called knows before
  accepting.
- **Who can call you is your own door.** By default only people you already
  have a conversation with — a setting, all the way up to everyone and all the
  way down to nobody (calls can be switched off for the whole installation).
- **An incoming call that reaches beyond the tab.** A background tab flashes
  its title and rings; the desktop app raises its window, shows the call in
  its tray and hands the system a notification. The honest limit is on the
  screen where the call is placed, not discovered by experience: relay has no
  push gateway, so a call reaches someone only while relay is open in a
  browser tab or running as an app. Mobile web in the background will not
  catch one.
- **The owner panel.** Behind a shield that only the owner sees: 95 settings
  in twelve tabs — access, people, moderation, messages, files, direct
  messages, servers, voice, invites, appearance, notifications, maintenance.
  Almost everything lands at once, without a restart, and each field says when
  it lands. Beside the settings: everyone who ever signed in with their
  devices and fingerprints (revoke a device, or ban the person across the
  whole installation), installation-wide bans and address blocking before
  anything else is asked, and a log of every change with its author and time.
  Upkeep: export and import the settings, run the retention sweep by hand,
  sign every device out, issue a fresh owner link. Overview shows how much
  CPU, memory and disk the machine is using. Secrets never leave the server —
  the login password and the TURN/SFU keys are shown as "set" or "not set",
  not shown.
- **The daily settings stop being env variables.** Retention, upload quotas,
  rate limits, first-message rules, the DM policy, maintenance mode — seeded
  from `.env` once, governed from the panel from then on. Four fields stay in
  `.env` for good (the TURN and SFU addresses and keys); the panel shows them
  and says where to edit them.

### Changed

- **The rail grew a place for people.** The toolbar moved to the right edge,
  and next to the servers stands the Direct section — conversations live
  outside any server, so they are not stored as a server's channel. Search
  inside a conversation stays inside it; there are no pins and no mention
  counters there, and unread counts say how much is unread, not that something
  is.
- **A refused conversation is said out loud.** Opening a direct message that
  is no longer yours answers "this conversation isn't open to you anymore"
  instead of quietly failing, and the people picker says when its list is cut
  short and how to narrow it.

### Fixed

- **The feed respects the page size the owner set.** The message feed ignored
  the panel's page size and always served its own.
- **Idle tabs stop redrawing.** The animated background was re-rendered every
  frame; laptops no longer pay for a screen nobody is watching.
- **Every route out of voice now ends the conversation.** Leaving by any door
  closes the call for both sides and frees the seat — no ghost holding the
  microphone, no conversation outliving its people.

### The desktop client

Released alongside, from this same repository, as
[`desktop-v2.0.0`](https://github.com/frizzonje/relay/releases/tag/desktop-v2.0.0):
one version number continues to cover the app, the images and the packages.
Its own notes are on that page — the short version is that the app now knows
it can be called: an incoming call raises the window, the tray shows it, and
the system gets a notification even when the window is minimized.

### Not in this release

Push notifications, and with them incoming calls on a phone that has relay
closed. The question was decided: not now — a push gateway needs
infrastructure and keys that no self-hosted installation can provide for
itself, and promising one that does not exist would be worse than saying so on
the screen where it matters. The native iOS client does not receive calls yet
either; it connects and shows presence, and a call to it ends as "no answer".
End-to-end encryption remains out, for the reasons written in 1.0's notes; if
it ever comes, a conversation between two people is the natural place for it
to start.

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

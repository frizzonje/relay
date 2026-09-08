The desktop client for **relay 2.0** — the release where an address can name a
person, and the app can be called.

### The app can be called now

relay 2.0 adds calling a person — not joining their voice channel, ringing
them. The shell is what makes that work when the window is not the thing you
are looking at:

- **An incoming call raises the window** and puts it over everything else,
  even from the tray. Accept and decline live in the app itself.
- **The tray says what is happening** — "in a call", "muted", and for as long
  as it rings, "incoming call" — and then goes back to what it said before.
- **The system gets a notification** when a call arrives, so a minimized
  window is not a missed call.

### Conversations with one person

The new Direct section works the same in the app as in the browser:
conversations addressed to a person, with presence — online, in a call, away —
shown everywhere a person appears. A call from a conversation is always a
direct connection between the two of you, never through the media server.

### Also in this release

- **One version number for the whole product.** The app, the server images and
  the packages move together; 2.0.0 here is 2.0.0 there.
- Update in place from 1.0.x — Settings → “Check for updates”.
- **The honest limit, said where it matters:** a call reaches you only while
  the app is running. Minimized to the tray counts as running — it will ring.
  Quit the app and the caller gets "no answer"; relay has no push
  notifications to find you with.

### Which file to download

| System | File |
|---|---|
| macOS (Apple silicon) | `relay_2.0.0_aarch64.dmg` |
| macOS (Intel) | `relay_2.0.0_x64.dmg` |
| Windows | `relay_2.0.0_x64-setup.exe` (or the `.msi`) |
| Linux | `relay_2.0.0_linux_x86_64.AppImage` |
| Arch | AUR: `relay-desktop-bin` |

The `.sig` files next to them are for the built-in updater, not for you to
download.

---

This is the client. The server it talks to is released separately — see the
[changelog](https://github.com/frizzonje/relay/blob/main/CHANGELOG.md) for what
2.0 changes on the machine that runs relay, and
[Get started](https://github.com/frizzonje/relay#-get-started) for putting one up.

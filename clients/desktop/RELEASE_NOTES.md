The desktop client for **relay 1.0** — the release where a person stopped being
a name in a browser and became a key.

### Your key is born outside the browser, and stays there

relay 1.0 signs you in with an Ed25519 key pair instead of a name you typed. In
a browser that key lives in IndexedDB; inside this shell that road is closed —
writing a non-extractable key there wedges the WebKit storage process for good.
So the pair is created and used by the app itself, and the page only ever asks
it for a signature.

- **The secret goes into the system store**: Keychain on macOS, Credential
  Manager on Windows, a `0600` file under `~/.config/app.relay.desktop` on
  Linux. If the system store refuses, the app says so on screen and writes the
  reason to `relay-update.log` — it will not quietly mint you a second identity,
  which is what an empty account with someone else's history would look like.
- **Every server gets its own key.** The shell can switch servers, and one
  shared key would let one server ask you to sign a challenge taken from
  another.
- **macOS may ask for permission to use the Keychain** after an update: builds
  without a Developer ID are signed anew each time, so the system sees a new
  app. “Always allow” settles it until the next update.

### Also in this release

- **One version number for the whole product.** The app, the server images and
  the packages now move together; 1.0.0 here is 1.0.0 there.
- Update in place from 0.6.x — Settings → “Check for updates”.

### Calls on Linux still need a browser

The system WebKitGTK is built without WebRTC, so `RTCPeerConnection` does not
exist in this shell on Linux and voice channels cannot work in it. The app says
so plainly instead of joining a channel and going silent. Chat, servers and
notifications work; for a call, open the same server in a browser. Nothing in
relay can fix this — it needs a different engine, and that work is not done.

### Which file to download

| System | File |
|---|---|
| macOS (Apple silicon) | `relay_1.0.0_aarch64.dmg` |
| macOS (Intel) | `relay_1.0.0_x64.dmg` |
| Windows | `relay_1.0.0_x64-setup.exe` (or the `.msi`) |
| Debian / Ubuntu | `relay_1.0.0_amd64.deb` |
| Fedora / RHEL | `relay-1.0.0-1.x86_64.rpm` |
| Other Linux | `relay_1.0.0_amd64.AppImage` |
| Arch | AUR: `relay-desktop-bin` |

The `.sig` files next to them are for the built-in updater, not for you to
download.

---

This is the client. The server it talks to is released separately — see the
[changelog](https://github.com/frizzonje/relay/blob/main/CHANGELOG.md) for what
1.0 changes on the machine that runs relay, and
[Get started](https://github.com/frizzonje/relay#-get-started) for putting one up.

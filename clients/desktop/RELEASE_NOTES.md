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
  Linux (the Electron client uses that same file). If the system store refuses,
  the app says so on screen and writes the reason to `relay-update.log` — it
  will not quietly mint you a second identity,
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

### Linux can call now — on a different engine

The Linux client used to be the same Tauri shell, and it could not make a call:
the system WebKitGTK it embeds is built without WebRTC, so `RTCPeerConnection`
simply does not exist there. That is upstream's default and no distribution
changes it, so we changed the engine instead. **On Linux relay is now an
Electron shell** over the same web UI — calls, video and screen sharing work
like they do in a browser, and the tray, autostart and updates work like they do
on Windows and macOS.

- **You stay yourself.** The new client reads the same identity key file and the
  same settings as the old one, so an update keeps your name, your key and your
  autostart setting.
- **One update takes you across**: the AppImage is replaced in place by the
  built-in updater; afterwards the new client updates itself.
- **What is not there yet**: the global push-to-talk hotkey (on Wayland it needs
  a desktop portal whose bugs are still open — the setting is hidden rather than
  shown and broken), and system audio while sharing your screen, which the
  engine does not hand over on Linux.
- **Packages**: only the AppImage now — `.deb`/`.rpm` are gone. Arch users get
  the AUR recipe that repackages it.

### Which file to download

| System | File |
|---|---|
| macOS (Apple silicon) | `relay_1.0.0_aarch64.dmg` |
| macOS (Intel) | `relay_1.0.0_x64.dmg` |
| Windows | `relay_1.0.0_x64-setup.exe` (or the `.msi`) |
| Linux | `relay_1.0.0_linux_x86_64.AppImage` |
| Arch | AUR: `relay-desktop-bin` |

The `.sig` files next to them are for the built-in updater, not for you to
download.

---

This is the client. The server it talks to is released separately — see the
[changelog](https://github.com/frizzonje/relay/blob/main/CHANGELOG.md) for what
1.0 changes on the machine that runs relay, and
[Get started](https://github.com/frizzonje/relay#-get-started) for putting one up.

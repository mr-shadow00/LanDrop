# LanDrop

A self-hosted, Snapdrop-style file drop for your local network — drag a file
onto a device on screen and it flies straight there, browser to browser.
No accounts, no upload-then-download round trip through the server, no app
to install on the other devices (just open the page).

Built to fix the things that make Snapdrop flaky with real files:
- Chunked sends with backpressure (waits for the network to catch up instead
  of blasting the whole file into the data channel at once), which is the
  usual cause of large-file transfers stalling or corrupting.
- Auto-reconnecting signaling, so a dropped WiFi connection doesn't require
  a page reload.
- ICE restart on connection failure instead of a dead, silent transfer.
- A stale-peer heartbeat, so devices that vanished (closed laptop, phone
  asleep) don't linger in the list.

## Install on ZimaOS

1. Make these folders and move the app files into them (you can rename
   `landrop` to whatever you like, just keep it consistent everywhere):
   ```
   /DATA/AppData/landrop/app/   ← server/, public/, package.json, package-lock.json go here
   ```
2. In the ZimaOS App Store, choose **Install a Customized App** → **Docker
   Compose** tab, and paste in `LanDrop compose.yaml`.
3. Wait for the first boot — it runs `npm install` once, then starts.
4. Open `http://<your-zimaos-ip>:8091` on every device you want to share
   files with.
5. Open the same URL on a second device (phone, laptop, whatever), see it
   appear as a circle, and drag a file onto it (or tap it to pick a file).

Change the port on the left of `"8091:3000"` in the compose file if 8091 is
already taken on your box.

## Installing it as an app on each device

LanDrop is a PWA. On desktop Chrome/Edge, click the install icon in the
address bar. On Android Chrome, use "Add to Home screen". On iOS Safari,
use Share → "Add to Home Screen". It'll then open in its own window/icon
like a native app, no browser chrome.

## Notes

- Transfers are peer-to-peer over WebRTC; the server only helps two
  browsers introduce themselves (signaling). Files never sit on the NAS.
- Everyone who can reach the server URL sees everyone else currently on the
  page — there's no pairing code, same as Snapdrop. If your NAS is only
  reachable on your home network, that's your trust boundary.
- Works great over the same LAN/VLAN. If some of your devices are on
  separate VLANs or behind isolated WiFi client networks with no route
  between them, WebRTC may not be able to establish a direct path — that's
  a network-topology limit, not something the app can route around.

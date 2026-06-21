# Filedrop relay server

A tiny rendezvous + relay so Filedrop devices connect **over the internet by code** — no same network, no VPN, no port-forwarding. Each device opens one outbound WebSocket, registers its unique code, and the server forwards messages between codes.

## Deploy to Render (free, easiest)

1. Go to <https://render.com> → sign up (free) with your GitHub.
2. **New ➜ Blueprint** → pick the `otkaa/filedrop` repo → **Apply**.
   (Render reads `render.yaml` and creates the `filedrop-relay` web service.)
3. When it's live you'll get a URL like `https://filedrop-relay.onrender.com`.
   Open `https://<that-url>/health` — it should say `{"ok":true,...}`.
4. Tell me that URL — I wire both apps to it.

> Free tier note: the server sleeps after ~15 min with nobody connected and takes ~30 s to wake on the next connect. Fine for testing; we can switch it to always-on later.

### Push (FCM) — required for offline call/message wake-ups

So calls and messages reach a recipient whose app is fully closed, the relay sends Firebase Cloud Messaging (FCM) pushes. On Render, set an env var:

- **`FIREBASE_SERVICE_ACCOUNT`** — the Firebase service-account JSON (the whole file, as a single-line string). Render ➜ the `filedrop-relay` service ➜ **Environment** ➜ add the key.

If the var is missing or invalid, the relay logs a warning and simply runs **without push** — online relaying still works and the server never crashes. (For local dev only, it will fall back to reading `C:\Users\Admin\fcm-sa.json` if the env var is unset; never commit that file.)

## Run locally

```
cd server
npm install
npm start          # listens on :8080
node selftest.js   # 2-client delivery test
```

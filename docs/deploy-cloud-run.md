# Deploying Team Talkie on Google Cloud Run

This walkthrough assumes the Google Cloud project provided for the Texas A&M environment
(or any project you control). Cloud Run is a good fit for the server because it gives you
TLS (`wss://`) automatically and can scale to zero.

> **Important:** room state is in memory. Run **one instance** (`--max-instances=1`).
> Multiple instances would give each caller a different view of the room.

## 1. Prerequisites

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com
```

Build the standalone server bundle locally first:

```bash
npm install
npm run build:server
```

`apps/server/dist/server.js` is a single bundled file; `apps/server/Dockerfile` copies it
onto a small Node image. `.gcloudignore` keeps source and tests out of the upload while
including `dist/`.

## 2. Deploy

```bash
gcloud run deploy team-talkie \
  --source apps/server \
  --region us-central1 \
  --allow-unauthenticated \
  --port 8080 \
  --max-instances 1 \
  --min-instances 1 \
  --cpu 1 \
  --memory 256Mi \
  --timeout 3600 \
  --set-env-vars TRUST_PROXY=1,LOG_LEVEL=info
```

Notes:

- `--timeout 3600` is the maximum. Individual WebSocket connections are still subject to
  that 60-minute request limit; the widget reconnects immediately and keeps its place for
  the 8-second grace window.
- `--min-instances 1` avoids a cold start when the first person joins a meeting. Use `0`
  if you prefer scale-to-zero and can tolerate a second of warm-up.
- `TRUST_PROXY=1` makes the rate limiter use `X-Forwarded-For`.
- Do **not** add `--session-affinity` as a substitute for a single instance; WebSockets
  already stay on the same connection, and in-memory state cannot be shared.

Get the URL:

```bash
gcloud run services describe team-talkie --region us-central1 \
  --format='value(status.url)'
```

The public URL uses HTTPS. In the widget's **Settings → Connection** enter the equivalent
WebSocket URL:

```
wss://team-talkie-xxxxxxxx-uc.a.run.app
```

The client appends `/ws`. The server also exposes:

- `GET /api/health` — process and room counts
- `GET /api/rooms/:code` — room metadata used by the join screen
- `WS /ws` — realtime traffic

## 3. Verify

```bash
curl https://YOUR_SERVICE_URL/api/health
# {"ok":true,"service":"team-talkie",...}
```

Then create a room from two devices. You should see the same order and the same "next"
label on both.

## 4. Optional environment variables

| Variable | Purpose |
| --- | --- |
| `ALLOWED_ORIGINS` | Comma-separated browser origins. The Electron app (file/native origin) is always allowed. Add `https://your-web-preview.example` if you host the browser build. |
| `ROOM_IDLE_MS` | How long an empty room is kept (default 30 min). |
| `ROOM_MAX_AGE_MS` | Hard room lifetime (default 24 h). |
| `RECONNECT_GRACE_MS` | Default 8 s. |
| `MAX_ROOMS` | Process capacity guard. |

## 5. Deploying the desktop app

The desktop app is not hosted on Cloud Run. Build installers locally (or in CI) with:

```bash
npm run dist:win    # on Windows
npm run dist:mac    # on macOS
```

Artifacts land in `apps/desktop/release/`. Before distributing:

- set a default server URL at build time with `apps/desktop/.env`:
  `VITE_TALKIE_SERVER=wss://your-service-url`
- configure code signing / notarization in `apps/desktop/electron-builder.yml`
- optionally add auto-update

## 6. Scaling beyond one process

If you outgrow a single instance, the room model needs to move out of `Hub`:

1. Move room and member state to Redis or Firestore.
2. Add a pub/sub channel per room so each instance can fan out changes to its sockets.
3. Keep WebSocket connections sticky at the load balancer, or broadcast across instances.
4. Revisit the 8-person, 30-minute room TTL assumptions with the new storage costs.

The protocol is intentionally small, so a shared-store version can keep the same client.


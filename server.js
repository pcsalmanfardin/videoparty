/**
 * VideoParty server
 * - Serves the frontend (public/)
 * - Handles video file uploads:
 *     - If Backblaze B2 credentials are set (see .env.example), uploads go to B2
 *       (permanent storage, no credit card needed — survives server restarts/sleep
 *       on free hosting).
 *     - Otherwise falls back to local disk storage under /uploads (fine for local
 *       testing, but files are lost on redeploy/restart on most free hosts).
 * - Persists "what video is currently playing in each room" to B2 (if configured)
 *   so that if the server restarts, rejoining the room restores the video instead
 *   of forcing a re-upload.
 * - Kill switch: a secret /admin/<ADMIN_KEY> page lets the owner flip the whole
 *   site ON/OFF. When OFF, nobody (even with the app link) can create/join a
 *   room or upload a video — no password needed for regular visitors at all.
 * - Socket.io: room join/leave (max 2 users per room), video sync events,
 *   chat + emoji relay, WebRTC signaling relay for voice.
 */

const path = require("path");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const http = require("http");
const { Server } = require("socket.io");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---- Backblaze B2 (S3-compatible) setup ----
// B2 was chosen because its free tier (10GB) needs no credit card at signup —
// as long as the bucket stays PRIVATE. Video files are served through our own
// /media/* route, which signs a short-lived temporary URL on each request, so
// the bucket never needs to be made public.
const B2_ENABLED = !!(
  process.env.B2_KEY_ID &&
  process.env.B2_APPLICATION_KEY &&
  process.env.B2_ENDPOINT &&
  process.env.B2_REGION &&
  process.env.B2_BUCKET_NAME
);

let s3 = null;
if (B2_ENABLED) {
  s3 = new S3Client({
    region: process.env.B2_REGION,
    endpoint: `https://${process.env.B2_ENDPOINT}`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.B2_KEY_ID,
      secretAccessKey: process.env.B2_APPLICATION_KEY,
    },
  });
  console.log("B2 storage: ENABLED — uploaded videos will persist permanently.");
} else {
  console.log(
    "B2 storage: not configured — falling back to local disk (/uploads). " +
      "Files may be lost on restart/redeploy on free hosting. See .env.example."
  );
}

const B2_BUCKET_NAME = process.env.B2_BUCKET_NAME;

// ---- Kill switch ----
// ADMIN_KEY is a secret only the owner knows, used as part of a hidden URL
// (/admin/<ADMIN_KEY>) to flip the site ON/OFF. If ADMIN_KEY isn't set, the
// admin route is disabled entirely and the site defaults to always-ON.
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const ADMIN_ENABLED = ADMIN_KEY.length > 0;

// In-memory "is the site live" flag. Defaults to ON so the app works right
// after first deploy. Persisted to B2 (if configured) so the switch position
// survives server restarts/sleep on free hosting; without B2 it resets to ON
// on every restart.
let siteLive = true;

async function loadSiteState() {
  if (!B2_ENABLED) return;
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: B2_BUCKET_NAME, Key: "state/site.json" })
    );
    const body = await res.Body.transformToString();
    const parsed = JSON.parse(body);
    if (typeof parsed.live === "boolean") siteLive = parsed.live;
  } catch (err) {
    // No saved state yet — that's fine, keep the default (ON).
  }
}

async function saveSiteState() {
  if (!B2_ENABLED) return;
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: B2_BUCKET_NAME,
        Key: "state/site.json",
        Body: JSON.stringify({ live: siteLive }),
        ContentType: "application/json",
      })
    );
  } catch (err) {
    console.error("Failed to persist site state:", err.message);
  }
}

if (ADMIN_ENABLED) {
  console.log(`Kill switch: ENABLED — control it at /admin/<your ADMIN_KEY>.`);
} else {
  console.log(
    "Kill switch: not configured — the site is always ON for everyone with the link. " +
      "Set ADMIN_KEY to enable the on/off switch. See .env.example."
  );
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR)); // only used in local-disk fallback mode

// ---- Public status check (frontend uses this to show the "offline" screen) ----
app.get("/site-status", (req, res) => {
  res.json({ live: siteLive });
});

// ---- Admin panel (hidden behind a secret URL) ----
function renderAdminPage(key) {
  return `<!DOCTYPE html>
<html lang="bn"><head><meta charset="UTF-8">
<title>VideoParty Admin</title>
<style>
  body { background:#121016; color:#f1eee6; font-family: system-ui, sans-serif;
         display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
  .card { background:#1c1a22; border:1px solid #34303d; border-radius:12px; padding:36px;
          width:100%; max-width:380px; text-align:center; }
  h1 { font-size:22px; margin-bottom: 8px; }
  .status { font-size:15px; margin: 18px 0; padding: 10px; border-radius: 8px; }
  .status.on { background: rgba(111,208,140,0.15); color:#6fd08c; }
  .status.off { background: rgba(224,92,92,0.15); color:#e05c5c; }
  button { cursor:pointer; border:none; border-radius:8px; padding:14px 20px; font-size:15px;
           font-weight:600; width:100%; margin-top:8px; }
  .turn-on { background:#6fd08c; color:#0c1f13; }
  .turn-off { background:#e05c5c; color:#2a0e0e; }
</style></head>
<body>
  <div class="card">
    <h1>🎛️ VideoParty Admin</h1>
    <div id="status" class="status">লোড হচ্ছে...</div>
    <button id="toggleBtn" onclick="toggle()">...</button>
  </div>
  <script>
    const key = ${JSON.stringify(key)};
    async function refresh() {
      const res = await fetch('/admin-api/' + key + '/status');
      const data = await res.json();
      render(data.live);
    }
    async function toggle() {
      const res = await fetch('/admin-api/' + key + '/toggle', { method: 'POST' });
      const data = await res.json();
      render(data.live);
    }
    function render(live) {
      const statusEl = document.getElementById('status');
      const btn = document.getElementById('toggleBtn');
      if (live) {
        statusEl.textContent = '🟢 সাইট এখন লাইভ (সবাই ঢুকতে পারবে)';
        statusEl.className = 'status on';
        btn.textContent = 'সাইট বন্ধ করে দিন';
        btn.className = 'turn-off';
      } else {
        statusEl.textContent = '🔴 সাইট এখন বন্ধ (কেউ ঢুকতে পারবে না)';
        statusEl.className = 'status off';
        btn.textContent = 'সাইট চালু করুন';
        btn.className = 'turn-on';
      }
    }
    refresh();
  </script>
</body></html>`;
}

app.get("/admin/:key", (req, res) => {
  if (!ADMIN_ENABLED || req.params.key !== ADMIN_KEY) {
    return res.status(404).send("Not found");
  }
  res.send(renderAdminPage(req.params.key));
});

app.get("/admin-api/:key/status", (req, res) => {
  if (!ADMIN_ENABLED || req.params.key !== ADMIN_KEY) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json({ live: siteLive });
});

app.post("/admin-api/:key/toggle", async (req, res) => {
  if (!ADMIN_ENABLED || req.params.key !== ADMIN_KEY) {
    return res.status(404).json({ error: "Not found" });
  }
  siteLive = !siteLive;
  await saveSiteState();
  console.log(`Kill switch toggled: site is now ${siteLive ? "LIVE" : "OFF"}.`);
  if (!siteLive) {
    io.emit("site-offline"); // tell everyone currently connected, mid-session
  }
  res.json({ live: siteLive });
});

// ---- File upload endpoint ----
// Always land the incoming file on local disk first (multer diskStorage), then,
// if B2 is enabled, stream it up to B2 and delete the local temp copy. Streaming
// (rather than buffering in memory) keeps RAM usage low even for large videos.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || "";
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB cap, adjust as needed
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("video/")) cb(null, true);
    else cb(new Error("Only video files are allowed"));
  },
});

app.post("/upload", upload.single("video"), async (req, res) => {
  if (!siteLive) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(403).json({ error: "This watch party is currently offline." });
  }
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  if (!B2_ENABLED) {
    // Local-disk fallback
    return res.json({ url: `/uploads/${req.file.filename}`, name: req.file.originalname });
  }

  try {
    const key = `videos/${req.file.filename}`;
    const fileStream = fs.createReadStream(req.file.path);

    const uploader = new Upload({
      client: s3,
      params: {
        Bucket: B2_BUCKET_NAME,
        Key: key,
        Body: fileStream,
        ContentType: req.file.mimetype,
      },
    });
    await uploader.done();

    fs.unlink(req.file.path, () => {}); // clean up local temp copy

    // Stable internal path — never expires, works regardless of domain.
    // Actual signed access to the (private) B2 object happens on each request
    // to this path, see the /media/* route below.
    res.json({ url: `/media/${key}`, name: req.file.originalname });
  } catch (err) {
    console.error("B2 upload failed:", err);
    fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: "Upload to storage failed. Please try again." });
  }
});

// ---- Serve private B2 objects via short-lived signed URLs ----
// The bucket stays PRIVATE (no credit card needed on Backblaze). Instead of
// exposing a public bucket URL, the browser requests OUR server at /media/<key>,
// and we redirect it to a freshly-signed, temporary B2 URL (valid a few hours).
app.get("/media/*", async (req, res) => {
  if (!siteLive) return res.status(403).send("This watch party is currently offline.");
  if (!B2_ENABLED) return res.status(404).send("Not found");
  const key = req.params[0];
  try {
    const command = new GetObjectCommand({ Bucket: B2_BUCKET_NAME, Key: key });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 6 * 60 * 60 }); // 6 hours
    res.redirect(302, signedUrl);
  } catch (err) {
    console.error("Failed to sign media URL:", err.message);
    res.status(404).send("Video not found");
  }
});

// ---- Room state persistence (so a server restart doesn't lose "what's playing") ----
async function saveRoomState(roomId, room) {
  if (!B2_ENABLED) return;
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: B2_BUCKET_NAME,
        Key: `state/${roomId}.json`,
        Body: JSON.stringify({ video: room.video, playback: room.playback }),
        ContentType: "application/json",
      })
    );
  } catch (err) {
    console.error("Failed to persist room state:", err.message);
  }
}

async function loadRoomState(roomId) {
  if (!B2_ENABLED) return null;
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: B2_BUCKET_NAME, Key: `state/${roomId}.json` })
    );
    const body = await res.Body.transformToString();
    return JSON.parse(body);
  } catch (err) {
    return null; // no saved state yet, or not found — that's fine
  }
}

// ---- In-memory room state ----
// rooms: Map<roomId, { users: Map<socketId, {name}>, video, playback, lastPersistedAt }>
const rooms = new Map();

async function getOrLoadRoom(roomId) {
  if (rooms.has(roomId)) return rooms.get(roomId);

  const saved = await loadRoomState(roomId);
  const room = {
    users: new Map(),
    video: saved?.video || null,
    playback: saved?.playback || { isPlaying: false, time: 0, updatedAt: Date.now() },
    lastPersistedAt: 0,
  };
  rooms.set(roomId, room);
  return room;
}

function roomUserList(room) {
  return Array.from(room.users.entries()).map(([id, u]) => ({ id, name: u.name }));
}

io.on("connection", (socket) => {
  let currentRoom = null;
  let currentName = null;

  socket.on("join-room", async ({ roomId, name }, ack) => {
    if (!siteLive) {
      return ack && ack({ ok: false, error: "এই ওয়াচ পার্টি এই মুহূর্তে বন্ধ আছে।" });
    }
    if (!roomId || typeof roomId !== "string") {
      return ack && ack({ ok: false, error: "Invalid room id" });
    }
    const room = await getOrLoadRoom(roomId);
    if (room.users.size >= 2) {
      return ack && ack({ ok: false, error: "This room already has 2 people in it." });
    }

    currentRoom = roomId;
    currentName = (name || "Guest").slice(0, 30);
    room.users.set(socket.id, { name: currentName });
    socket.join(roomId);

    ack &&
      ack({
        ok: true,
        users: roomUserList(room),
        video: room.video,
        playback: room.playback,
      });

    socket.to(roomId).emit("peer-joined", { id: socket.id, name: currentName });
  });

  socket.on("select-video", async ({ type, src, title }) => {
    if (!currentRoom || !siteLive) return;
    const room = await getOrLoadRoom(currentRoom);
    room.video = { type, src, title: title || "" };
    room.playback = { isPlaying: false, time: 0, updatedAt: Date.now() };
    io.to(currentRoom).emit("video-selected", room.video);
    saveRoomState(currentRoom, room); // fire-and-forget, always persist on video change
  });

  // playback: { isPlaying, time }
  socket.on("playback-update", async (playback) => {
    if (!currentRoom || !siteLive) return;
    const room = await getOrLoadRoom(currentRoom);
    room.playback = { ...playback, updatedAt: Date.now() };
    socket.to(currentRoom).emit("playback-update", room.playback);

    // Throttle persistence to avoid hammering B2 on every timeupdate/seek.
    const now = Date.now();
    if (now - (room.lastPersistedAt || 0) > 8000) {
      room.lastPersistedAt = now;
      saveRoomState(currentRoom, room);
    }
  });

  socket.on("chat-message", (msg) => {
    if (!currentRoom || !siteLive) return;
    const payload = { name: currentName, text: String(msg || "").slice(0, 1000), at: Date.now() };
    io.to(currentRoom).emit("chat-message", payload);
  });

  socket.on("emoji", (emoji) => {
    if (!currentRoom || !siteLive) return;
    io.to(currentRoom).emit("emoji", { name: currentName, emoji, at: Date.now() });
  });

  // ---- WebRTC signaling relay (voice) ----
  socket.on("webrtc-signal", (data) => {
    if (!currentRoom || !siteLive) return;
    socket.to(currentRoom).emit("webrtc-signal", { from: socket.id, ...data });
  });

  socket.on("disconnect", async () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.users.delete(socket.id);
    socket.to(currentRoom).emit("peer-left", { id: socket.id });
    if (room.users.size === 0) {
      // Persist final state before dropping the in-memory copy — B2 (if enabled)
      // keeps the video/playback around so the room can be restored later.
      await saveRoomState(currentRoom, room);
      rooms.delete(currentRoom);
    }
  });
});

loadSiteState().finally(() => {
  server.listen(PORT, () => {
    console.log(`VideoParty running on http://localhost:${PORT}`);
  });
});

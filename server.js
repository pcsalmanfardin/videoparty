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

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 });

app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR)); // only used in local-disk fallback mode

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
    if (!currentRoom) return;
    const room = await getOrLoadRoom(currentRoom);
    room.video = { type, src, title: title || "" };
    room.playback = { isPlaying: false, time: 0, updatedAt: Date.now() };
    io.to(currentRoom).emit("video-selected", room.video);
    saveRoomState(currentRoom, room); // fire-and-forget, always persist on video change
  });

  // playback: { isPlaying, time }
  socket.on("playback-update", async (playback) => {
    if (!currentRoom) return;
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
    if (!currentRoom) return;
    const payload = { name: currentName, text: String(msg || "").slice(0, 1000), at: Date.now() };
    io.to(currentRoom).emit("chat-message", payload);
  });

  socket.on("emoji", (emoji) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit("emoji", { name: currentName, emoji, at: Date.now() });
  });

  // ---- WebRTC signaling relay (voice) ----
  socket.on("webrtc-signal", (data) => {
    if (!currentRoom) return;
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

server.listen(PORT, () => {
  console.log(`VideoParty running on http://localhost:${PORT}`);
});

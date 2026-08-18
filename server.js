/**
 * VideoParty server
 * - Serves the frontend (public/)
 * - Handles video file uploads (multer -> /uploads)
 * - Socket.io: room join/leave (max 2 users per room), video sync events,
 *   chat + emoji relay, WebRTC signaling relay for voice chat.
 */

const path = require("path");
const fs = require("fs");
const express = require("express");
const multer = require("multer");
const http = require("http");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e8, // generous, though video goes via /upload not socket
});

app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR));

// ---- File upload endpoint ----
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

app.post("/upload", upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  res.json({ url: `/uploads/${req.file.filename}`, name: req.file.originalname });
});

// ---- In-memory room state ----
// rooms: Map<roomId, { users: Map<socketId, {name}>, video: {type, src, title} | null,
//                       playback: {isPlaying, time, updatedAt} }>
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      users: new Map(),
      video: null,
      playback: { isPlaying: false, time: 0, updatedAt: Date.now() },
    });
  }
  return rooms.get(roomId);
}

function roomUserList(room) {
  return Array.from(room.users.entries()).map(([id, u]) => ({ id, name: u.name }));
}

io.on("connection", (socket) => {
  let currentRoom = null;
  let currentName = null;

  socket.on("join-room", ({ roomId, name }, ack) => {
    if (!roomId || typeof roomId !== "string") {
      return ack && ack({ ok: false, error: "Invalid room id" });
    }
    const room = getRoom(roomId);
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

  socket.on("select-video", ({ type, src, title }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    room.video = { type, src, title: title || "" };
    room.playback = { isPlaying: false, time: 0, updatedAt: Date.now() };
    io.to(currentRoom).emit("video-selected", room.video);
  });

  // playback: { isPlaying, time }
  socket.on("playback-update", (playback) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    room.playback = { ...playback, updatedAt: Date.now() };
    socket.to(currentRoom).emit("playback-update", room.playback);
  });

  socket.on("chat-message", (msg) => {
    if (!currentRoom) return;
    const payload = {
      name: currentName,
      text: String(msg || "").slice(0, 1000),
      at: Date.now(),
    };
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

  socket.on("disconnect", () => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    room.users.delete(socket.id);
    socket.to(currentRoom).emit("peer-left", { id: socket.id });
    if (room.users.size === 0) {
      rooms.delete(currentRoom);
    }
  });
});

server.listen(PORT, () => {
  console.log(`VideoParty running on http://localhost:${PORT}`);
});

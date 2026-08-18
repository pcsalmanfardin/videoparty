// ===================== VideoParty client =====================

const socket = io();

// ---- DOM refs ----
const joinScreen = document.getElementById("join-screen");
const roomScreen = document.getElementById("room-screen");
const nameInput = document.getElementById("name-input");
const roomInput = document.getElementById("room-input");
const createRoomBtn = document.getElementById("create-room-btn");
const joinRoomBtn = document.getElementById("join-room-btn");
const joinError = document.getElementById("join-error");

const roomIdDisplay = document.getElementById("room-id-display");
const copyRoomBtn = document.getElementById("copy-room-btn");
const peerStatus = document.getElementById("peer-status");
const micBtn = document.getElementById("mic-btn");

const videoPicker = document.getElementById("video-picker");
const fileInput = document.getElementById("file-input");
const linkInput = document.getElementById("link-input");
const linkBtn = document.getElementById("link-btn");
const uploadProgress = document.getElementById("upload-progress");

const playerArea = document.getElementById("player-area");
const html5Player = document.getElementById("html5-player");
const youtubeContainer = document.getElementById("youtube-player");
const linkFallback = document.getElementById("link-fallback");
const linkFallbackAnchor = document.getElementById("link-fallback-anchor");

const reactionLayer = document.getElementById("reaction-layer");
const chatLog = document.getElementById("chat-log");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");

const remoteAudio = document.getElementById("remote-audio");

// ---- State ----
let myName = "";
let myRoom = "";
let otherPeerId = null;
let ytPlayer = null;
let ytReady = false;
let currentVideo = null; // { type: 'file'|'youtube'|'link', src, title }
let applyingRemoteUpdate = false; // guard to avoid echo loops
let lastSentAt = 0;

// ===================== JOIN FLOW =====================

function randomRoomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

createRoomBtn.addEventListener("click", () => {
  const code = roomInput.value.trim() || randomRoomCode();
  attemptJoin(code);
});

joinRoomBtn.addEventListener("click", () => {
  const code = roomInput.value.trim();
  if (!code) {
    joinError.textContent = "রুমে যোগ দিতে একটা রুম কোড লিখুন।";
    return;
  }
  attemptJoin(code);
});

function attemptJoin(roomId) {
  myName = (nameInput.value.trim() || "Guest").slice(0, 30);
  joinError.textContent = "";
  socket.emit("join-room", { roomId, name: myName }, (res) => {
    if (!res.ok) {
      joinError.textContent = res.error || "রুমে যোগ দেওয়া যায়নি।";
      return;
    }
    myRoom = roomId;
    enterRoom(res);
  });
}

function enterRoom(state) {
  joinScreen.classList.add("hidden");
  roomScreen.classList.remove("hidden");
  roomIdDisplay.textContent = myRoom;

  const others = (state.users || []).filter((u) => u.id !== socket.id);
  if (others.length > 0) {
    otherPeerId = others[0].id;
    setPeerStatus(true);
    addSystemMessage(`${others[0].name} রুমে আছে।`);
  } else {
    setPeerStatus(false);
  }

  if (state.video) {
    loadVideo(state.video, true);
    if (state.playback) applyRemotePlayback(state.playback);
  }
}

function setPeerStatus(connected) {
  if (connected) {
    peerStatus.textContent = "বন্ধু রুমে আছে ✅";
    peerStatus.classList.add("connected");
  } else {
    peerStatus.textContent = "অপেক্ষা করছে বন্ধুর জন্য...";
    peerStatus.classList.remove("connected");
  }
}

copyRoomBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(myRoom).then(() => {
    copyRoomBtn.textContent = "কপি হয়েছে ✓";
    setTimeout(() => (copyRoomBtn.textContent = "রুম কোড কপি করুন"), 1500);
  });
});

// ===================== PEER PRESENCE =====================

socket.on("peer-joined", ({ id, name }) => {
  otherPeerId = id;
  setPeerStatus(true);
  addSystemMessage(`${name} রুমে যোগ দিয়েছে।`);
  maybeStartNegotiation();
});

socket.on("peer-left", ({ id }) => {
  if (id === otherPeerId) {
    otherPeerId = null;
    setPeerStatus(false);
    addSystemMessage("বন্ধু রুম থেকে বেরিয়ে গেছে।");
    teardownPeerConnection();
  }
});

// ===================== VIDEO SELECTION =====================

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  uploadProgress.textContent = "আপলোড হচ্ছে... 0%";

  const formData = new FormData();
  formData.append("video", file);

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/upload");
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      uploadProgress.textContent = `আপলোড হচ্ছে... ${pct}%`;
    }
  };
  xhr.onload = () => {
    if (xhr.status === 200) {
      const data = JSON.parse(xhr.responseText);
      uploadProgress.textContent = "আপলোড সম্পন্ন ✓";
      const video = { type: "file", src: data.url, title: data.name };
      socket.emit("select-video", video);
      loadVideo(video, true);
    } else {
      uploadProgress.textContent = "আপলোড ব্যর্থ হয়েছে।";
    }
  };
  xhr.onerror = () => (uploadProgress.textContent = "আপলোড ব্যর্থ হয়েছে।");
  xhr.send(formData);
});

linkBtn.addEventListener("click", () => {
  const url = linkInput.value.trim();
  if (!url) return;
  const ytId = extractYouTubeId(url);
  const video = ytId
    ? { type: "youtube", src: ytId, title: "YouTube video" }
    : { type: "link", src: url, title: url };
  socket.emit("select-video", video);
  loadVideo(video, true);
});

function extractYouTubeId(url) {
  const patterns = [
    /youtu\.be\/([^?&]+)/,
    /youtube\.com\/watch\?v=([^?&]+)/,
    /youtube\.com\/embed\/([^?&]+)/,
    /youtube\.com\/shorts\/([^?&]+)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

socket.on("video-selected", (video) => {
  loadVideo(video, true);
});

function loadVideo(video, announce) {
  currentVideo = video;
  videoPicker.classList.add("hidden");
  playerArea.classList.remove("hidden");

  html5Player.classList.add("hidden");
  youtubeContainer.classList.add("hidden");
  linkFallback.classList.add("hidden");
  html5Player.pause();
  html5Player.removeAttribute("src");
  if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();

  if (video.type === "file") {
    html5Player.src = video.src;
    html5Player.classList.remove("hidden");
    attachHtml5Listeners();
  } else if (video.type === "youtube") {
    youtubeContainer.classList.remove("hidden");
    setupYouTubePlayer(video.src);
  } else {
    linkFallback.classList.remove("hidden");
    linkFallbackAnchor.href = video.src;
  }

  if (announce) addSystemMessage(`ভিডিও লোড হয়েছে: ${video.title || video.src}`);
}

// ===================== HTML5 VIDEO SYNC =====================

let html5ListenersAttached = false;
function attachHtml5Listeners() {
  if (html5ListenersAttached) return;
  html5ListenersAttached = true;

  html5Player.addEventListener("play", () => sendPlayback(true));
  html5Player.addEventListener("pause", () => sendPlayback(false));
  html5Player.addEventListener("seeked", () => sendPlayback(!html5Player.paused));
}

function sendPlayback(isPlaying) {
  if (applyingRemoteUpdate) return;
  const now = Date.now();
  lastSentAt = now;
  const time = currentVideo.type === "youtube" && ytPlayer ? ytPlayer.getCurrentTime() : html5Player.currentTime;
  socket.emit("playback-update", { isPlaying, time });
}

socket.on("playback-update", (playback) => applyRemotePlayback(playback));

function applyRemotePlayback(playback) {
  applyingRemoteUpdate = true;
  const targetTime = playback.time + (playback.isPlaying ? (Date.now() - playback.updatedAt) / 1000 : 0);

  if (currentVideo && currentVideo.type === "youtube" && ytReady && ytPlayer) {
    const diff = Math.abs(ytPlayer.getCurrentTime() - targetTime);
    if (diff > 1.2) ytPlayer.seekTo(targetTime, true);
    if (playback.isPlaying) ytPlayer.playVideo();
    else ytPlayer.pauseVideo();
  } else if (currentVideo && currentVideo.type === "file") {
    const diff = Math.abs(html5Player.currentTime - targetTime);
    if (diff > 1.2) html5Player.currentTime = targetTime;
    if (playback.isPlaying) html5Player.play().catch(() => {});
    else html5Player.pause();
  }

  setTimeout(() => (applyingRemoteUpdate = false), 300);
}

// ===================== YOUTUBE PLAYER =====================

function onYouTubeIframeAPIReady() {
  // Called automatically by the YT iframe API script once loaded.
  window.__ytApiReady = true;
}

function setupYouTubePlayer(videoId) {
  const create = () => {
    if (ytPlayer) {
      ytPlayer.loadVideoById(videoId);
      return;
    }
    ytPlayer = new YT.Player("youtube-player", {
      height: "480",
      width: "854",
      videoId,
      playerVars: { rel: 0 },
      events: {
        onReady: () => {
          ytReady = true;
        },
        onStateChange: (e) => {
          if (applyingRemoteUpdate) return;
          if (e.data === YT.PlayerState.PLAYING) sendPlaybackYT(true);
          else if (e.data === YT.PlayerState.PAUSED) sendPlaybackYT(false);
        },
      },
    });
  };

  if (window.YT && window.YT.Player) create();
  else {
    const waitForApi = setInterval(() => {
      if (window.YT && window.YT.Player) {
        clearInterval(waitForApi);
        create();
      }
    }, 200);
  }
}

function sendPlaybackYT(isPlaying) {
  if (!ytPlayer) return;
  socket.emit("playback-update", { isPlaying, time: ytPlayer.getCurrentTime() });
}

// ===================== CHAT =====================

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit("chat-message", text);
  chatInput.value = "";
});

socket.on("chat-message", ({ name, text, at }) => {
  addChatMessage(name, text, at);
});

function addChatMessage(name, text, at) {
  const el = document.createElement("div");
  el.className = "chat-msg";
  const time = new Date(at || Date.now()).toLocaleTimeString("bn-BD", { hour: "2-digit", minute: "2-digit" });
  el.innerHTML = `<span class="msg-name">${escapeHtml(name)}</span>${escapeHtml(text)} <span style="color:var(--text-muted); font-size:11px;">${time}</span>`;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function addSystemMessage(text) {
  const el = document.createElement("div");
  el.className = "chat-msg system";
  el.textContent = text;
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ===================== EMOJI REACTIONS =====================

document.querySelectorAll(".emoji-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const emoji = btn.dataset.emoji;
    socket.emit("emoji", emoji);
    showFloatingEmoji(emoji);
  });
});

socket.on("emoji", ({ emoji }) => showFloatingEmoji(emoji));

function showFloatingEmoji(emoji) {
  const el = document.createElement("div");
  el.className = "floating-emoji";
  el.textContent = emoji;
  el.style.left = Math.random() * 80 + 10 + "%";
  reactionLayer.appendChild(el);
  setTimeout(() => el.remove(), 2300);
}

// ===================== WEBRTC VOICE (perfect negotiation) =====================

let localStream = null;
let pc = null;
let micOn = false;
let makingOffer = false;
let ignoreOffer = false;

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

micBtn.addEventListener("click", async () => {
  if (!micOn) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micOn = true;
      micBtn.textContent = "🎙️ ভয়েস চালু আছে";
      micBtn.classList.add("on");
      ensurePeerConnection();
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    } catch (err) {
      addSystemMessage("মাইক্রোফোনের অনুমতি পাওয়া যায়নি।");
    }
  } else {
    micOn = false;
    micBtn.textContent = "🎤 ভয়েস চালু করুন";
    micBtn.classList.remove("on");
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    teardownPeerConnection();
  }
});

function ensurePeerConnection() {
  if (pc) return;
  pc = new RTCPeerConnection(rtcConfig);

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit("webrtc-signal", { type: "candidate", candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    remoteAudio.srcObject = e.streams[0];
  };

  pc.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      await pc.setLocalDescription();
      socket.emit("webrtc-signal", { type: "description", description: pc.localDescription });
    } catch (err) {
      console.error(err);
    } finally {
      makingOffer = false;
    }
  };
}

function teardownPeerConnection() {
  if (pc) {
    pc.close();
    pc = null;
  }
}

function maybeStartNegotiation() {
  // If mic is already on and peer just joined, (re)create connection so negotiation fires.
  if (micOn && localStream) {
    ensurePeerConnection();
    localStream.getTracks().forEach((track) => {
      const already = pc.getSenders().some((s) => s.track === track);
      if (!already) pc.addTrack(track, localStream);
    });
  }
}

// "Polite" peer = the one with the lexicographically larger socket id.
// Determined once we know both ids; avoids both sides offering simultaneously.
function isPolite() {
  if (!otherPeerId) return true;
  return socket.id > otherPeerId;
}

socket.on("webrtc-signal", async ({ from, type, description, candidate }) => {
  otherPeerId = otherPeerId || from;
  ensurePeerConnection();

  try {
    if (type === "description") {
      const offerCollision = description.type === "offer" && (makingOffer || pc.signalingState !== "stable");
      ignoreOffer = !isPolite() && offerCollision;
      if (ignoreOffer) return;

      await pc.setRemoteDescription(description);
      if (description.type === "offer") {
        await pc.setLocalDescription();
        socket.emit("webrtc-signal", { type: "description", description: pc.localDescription });
      }
    } else if (type === "candidate") {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        if (!ignoreOffer) throw err;
      }
    }
  } catch (err) {
    console.error("WebRTC signaling error:", err);
  }
});

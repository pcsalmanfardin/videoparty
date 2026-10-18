// ===================== VideoParty client =====================

const socket = io();

// A stable identity for this browser tab. It survives socket reconnects (and a
// reload of the same tab), so the server can tell "the same person coming back
// after their phone slept" apart from "a different person trying to join".
const clientId = (() => {
  const fresh = () =>
    window.crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  try {
    let id = sessionStorage.getItem("vp_client_id");
    if (!id) {
      id = fresh();
      sessionStorage.setItem("vp_client_id", id);
    }
    return id;
  } catch (err) {
    return fresh();
  }
})();

// True once we've successfully joined a room; used to rejoin it automatically
// whenever the connection drops and comes back.
let inRoom = false;

// ---- DOM refs ----
const offlineScreen = document.getElementById("offline-screen");
const offlineRetryBtn = document.getElementById("offline-retry-btn");

const joinScreen = document.getElementById("join-screen");
const roomScreen = document.getElementById("room-screen");
const nameInput = document.getElementById("name-input");
const roomInput = document.getElementById("room-input");
const roomBtn = document.getElementById("room-btn");
const joinError = document.getElementById("join-error");

const roomIdDisplay = document.getElementById("room-id-display");
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
const fullscreenBtn = document.getElementById("fullscreen-btn");
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

// ===================== SITE STATUS (kill switch) =====================

async function initApp() {
  try {
    const res = await fetch("/site-status");
    const { live } = await res.json();
    if (live) {
      joinScreen.classList.remove("hidden");
    } else {
      offlineScreen.classList.remove("hidden");
    }
  } catch (err) {
    // If the check itself fails, still let people try — join-room will fail
    // gracefully server-side if the site is actually off.
    joinScreen.classList.remove("hidden");
  }
}

offlineRetryBtn.addEventListener("click", () => {
  offlineScreen.classList.add("hidden");
  initApp();
});

initApp();

socket.on("site-offline", () => {
  inRoom = false;
  joinScreen.classList.add("hidden");
  document.getElementById("room-screen").classList.add("hidden");
  offlineScreen.classList.remove("hidden");
});

// ===================== JOIN FLOW =====================

function randomRoomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// One button for both cases: the server joins the room if this code already
// exists, or creates it on the spot if it doesn't. Leaving the code empty
// generates a fresh random code. Codes are upper-cased so "abc" and "ABC"
// can't accidentally become two different rooms.
function submitRoom() {
  const code = roomInput.value.trim().toUpperCase() || randomRoomCode();
  attemptJoin(code);
}

roomBtn.addEventListener("click", submitRoom);
roomInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitRoom();
});

function attemptJoin(roomId) {
  myName = (nameInput.value.trim() || "Guest").slice(0, 30);
  joinError.textContent = "";
  socket.emit("join-room", { roomId, name: myName, clientId }, (res) => {
    if (!res.ok) {
      joinError.textContent = res.error || "রুমে যোগ দেওয়া যায়নি।";
      return;
    }
    myRoom = roomId;
    enterRoom(res);
  });
}

function enterRoom(state) {
  inRoom = true;
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

// Tapping the room code itself copies it (no separate button needed).
function fallbackCopy(text, done) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    if (document.execCommand("copy")) done();
  } catch (err) {
    /* nothing more we can do */
  }
  ta.remove();
}

function copyRoomCode() {
  const done = () => {
    roomIdDisplay.classList.add("copied");
    setTimeout(() => roomIdDisplay.classList.remove("copied"), 1500);
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(myRoom).then(done).catch(() => fallbackCopy(myRoom, done));
  } else {
    fallbackCopy(myRoom, done);
  }
}

roomIdDisplay.addEventListener("click", copyRoomCode);
roomIdDisplay.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    copyRoomCode();
  }
});

// ===================== PEER PRESENCE =====================

socket.on("peer-joined", ({ id, name }) => {
  // The friend is (re)joining: any voice link we hold is stale — either to their
  // previous connection, or created while they were away (so its offer reached
  // nobody). Drop it; maybeStartNegotiation() below starts a fresh one.
  teardownPeerConnection();
  otherPeerId = id;
  setPeerStatus(true);
  addSystemMessage(`${name} রুমে যোগ দিয়েছে।`);
  maybeStartNegotiation();
});

socket.on("peer-left", ({ id, name }) => {
  if (id === otherPeerId) {
    otherPeerId = null;
    setPeerStatus(false);
    const leftName = name || "বন্ধু";
    addSystemMessage(`${leftName} রুম থেকে বেরিয়ে গেছে। ভিডিও পজ করা হয়েছে — চাইলে আবার চালু করুন।`);
    if (currentVideo) {
      showFloatingMessage("সিস্টেম", `${leftName} চলে গেছে — ভিডিও পজ করা হয়েছে`);
    }
    teardownPeerConnection();
  }
});

// ===================== RECONNECT / REJOIN =====================
// When a phone sleeps or the network drops, the connection to the server dies
// and later comes back as a brand-new socket — which the server knows nothing
// about. Without rejoining, the screen still *looks* like we're in the room but
// play/pause, chat and voice silently go nowhere. So: rejoin automatically.

socket.on("disconnect", (reason) => {
  if (!inRoom) return;
  peerStatus.classList.remove("connected");
  if (reason === "io server disconnect") {
    // The server closed this connection on purpose (e.g. the same room was
    // opened again in a duplicated tab). Don't fight over the room.
    inRoom = false;
    peerStatus.textContent = "এই ট্যাবের সংযোগ বন্ধ হয়েছে";
    addSystemMessage("একই রুমে অন্য কোথাও যোগ দেওয়ায় এখানকার সংযোগ বন্ধ হয়েছে। পেজ রিলোড করে আবার ঢুকুন।");
    return;
  }
  peerStatus.textContent = "সংযোগ বিচ্ছিন্ন, আবার যুক্ত হওয়ার চেষ্টা চলছে…";
});

socket.on("connect", () => {
  if (inRoom) rejoinRoom();
});

function rejoinRoom() {
  socket.emit("join-room", { roomId: myRoom, name: myName, clientId }, (res) => {
    if (!res || !res.ok) {
      setPeerStatus(false);
      addSystemMessage((res && res.error) || "রুমে আবার যুক্ত হওয়া যায়নি।");
      return;
    }
    const others = (res.users || []).filter((u) => u.id !== socket.id);
    otherPeerId = others.length > 0 ? others[0].id : null;
    setPeerStatus(others.length > 0);
    addSystemMessage("সংযোগ ফিরে এসেছে — আবার রুমে যুক্ত হয়েছেন ✅");

    // Re-sync with the room's current state, without reloading a video we
    // already have (that would throw away what's been buffered).
    if (res.video && (!currentVideo || currentVideo.src !== res.video.src)) {
      loadVideo(res.video, true);
    }
    if (res.video && res.playback) applyRemotePlayback(res.playback);

    restoreVoiceAfterReconnect();
  });
}

// After a reconnect the old voice link is dead and, on phones, the microphone
// track is often ended too. Rebuild both if voice was on.
async function restoreVoiceAfterReconnect() {
  if (!micOn) return;
  teardownPeerConnection();
  const trackDead = !localStream || localStream.getTracks().every((t) => t.readyState === "ended");
  if (trackDead) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      micOn = false;
      localStream = null;
      setMicUi(false);
      addSystemMessage("মাইক আবার চালু করা যায়নি, ভয়েস বন্ধ হয়েছে। মাইক বাটনে চেপে আবার চালু করুন।");
      return;
    }
  }
  startVoiceIfNeeded();
}

// When the tab comes back to the front (or the network returns), check that the
// connection is really alive. A phone's socket can look "connected" for up to a
// minute after the link actually died; a quick probe finds out immediately.
let probingConnection = false;
function checkConnectionHealth() {
  if (!inRoom || probingConnection) return;
  if (!socket.connected) {
    socket.connect();
    return;
  }
  probingConnection = true;
  socket.timeout(4000).emit("hb", (err) => {
    probingConnection = false;
    if (err) {
      socket.disconnect();
      socket.connect(); // fires "connect" → rejoinRoom()
    }
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkConnectionHealth();
});
window.addEventListener("online", checkConnectionHealth);

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
  showFloatingMessage(name, text);
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

function showFloatingMessage(name, text) {
  const el = document.createElement("div");
  el.className = "floating-message";
  el.innerHTML = `<span class="msg-name">${escapeHtml(name)}</span>${escapeHtml(text)}`;
  el.style.left = Math.random() * 30 + 10 + "%";
  reactionLayer.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

// ===================== FULLSCREEN (video + reactions/messages together) =====================
// Prefer the real browser Fullscreen API when available — it also hides the
// browser's own address bar/UI on supporting browsers (e.g. Android Chrome),
// giving a true immersive fullscreen. On browsers that don't support it well
// (notably iOS Safari for non-<video> elements), we fall back to a CSS-only
// "fill the screen" mode that at least keeps everything visible, just without
// hiding the browser chrome.

function getFullscreenElement() {
  return (
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement ||
    document.msFullscreenElement ||
    null
  );
}

function requestFullscreenOn(el) {
  const request =
    el.requestFullscreen ||
    el.webkitRequestFullscreen ||
    el.mozRequestFullScreen ||
    el.msRequestFullscreen;
  if (!request) return Promise.reject(new Error("Fullscreen API not supported"));
  return request.call(el);
}

function exitNativeFullscreen() {
  const exit =
    document.exitFullscreen ||
    document.webkitExitFullscreen ||
    document.mozCancelFullScreen ||
    document.msExitFullscreen;
  if (exit) return exit.call(document);
  return Promise.resolve();
}

function setPseudoFullscreen(on) {
  playerArea.classList.toggle("pseudo-fullscreen", on);
  document.body.classList.toggle("no-scroll", on);
  fullscreenBtn.textContent = on ? "✕" : "⛶";
  fullscreenBtn.title = on ? "ফুলস্ক্রিন থেকে বেরিয়ে আসুন" : "ফুলস্ক্রিন (চ্যাট ও ইমোজি সহ)";
}

fullscreenBtn.addEventListener("click", () => {
  const isOn = playerArea.classList.contains("pseudo-fullscreen");
  if (isOn) {
    if (getFullscreenElement()) exitNativeFullscreen().catch(() => {});
    setPseudoFullscreen(false);
  } else {
    requestFullscreenOn(playerArea)
      .then(() => setPseudoFullscreen(true))
      .catch(() => setPseudoFullscreen(true)); // API unsupported/blocked — CSS-only fallback
  }
});

// If the person exits fullscreen via the system back button/gesture (rather
// than our button), keep our overlay state in sync.
["fullscreenchange", "webkitfullscreenchange", "mozfullscreenchange", "MSFullscreenChange"].forEach(
  (evt) => document.addEventListener(evt, () => {
    if (!getFullscreenElement() && playerArea.classList.contains("pseudo-fullscreen")) {
      setPseudoFullscreen(false);
    }
  })
);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && playerArea.classList.contains("pseudo-fullscreen")) {
    if (getFullscreenElement()) exitNativeFullscreen().catch(() => {});
    setPseudoFullscreen(false);
  }
});

// ===================== WEBRTC VOICE (perfect negotiation) =====================

let localStream = null;
let pc = null;
let micOn = false;
let makingOffer = false;
let ignoreOffer = false;

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

// The mic button is icon-only to save header space; keep its label for
// screen readers/tooltips in sync with its state.
function setMicUi(on) {
  micBtn.textContent = on ? "🎙️" : "🎤";
  const label = on ? "ভয়েস বন্ধ করুন" : "ভয়েস চালু করুন";
  micBtn.title = label;
  micBtn.setAttribute("aria-label", label);
  micBtn.classList.toggle("on", on);
}

micBtn.addEventListener("click", async () => {
  if (!micOn) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micOn = true;
      voiceRetries = 0;
      setMicUi(true);
      ensurePeerConnection();
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    } catch (err) {
      addSystemMessage("মাইক্রোফোনের অনুমতি পাওয়া যায়নি।");
    }
  } else {
    micOn = false;
    setMicUi(false);
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    teardownPeerConnection();
  }
});

let voiceRetries = 0;
let voiceWatchdog = null;
let politeOfferTimer = null;

function ensurePeerConnection() {
  if (pc) return;
  const conn = new RTCPeerConnection(rtcConfig);
  pc = conn;

  conn.onicecandidate = (e) => {
    if (e.candidate && pc === conn) socket.emit("webrtc-signal", { type: "candidate", candidate: e.candidate });
  };

  conn.ontrack = (e) => {
    remoteAudio.srcObject = e.streams[0];
  };

  conn.onnegotiationneeded = async () => {
    try {
      makingOffer = true;
      await conn.setLocalDescription();
      if (pc === conn) socket.emit("webrtc-signal", { type: "description", description: conn.localDescription });
    } catch (err) {
      console.error(err);
    } finally {
      makingOffer = false;
    }
  };

  conn.onconnectionstatechange = () => {
    if (pc !== conn) return;
    if (conn.connectionState === "connected") voiceRetries = 0;
    else if (conn.connectionState === "failed") rebuildVoice();
  };

  armVoiceWatchdog();
}

function teardownPeerConnection() {
  clearTimeout(voiceWatchdog);
  clearTimeout(politeOfferTimer);
  if (pc) {
    pc.close();
    pc = null;
  }
  makingOffer = false;
  ignoreOffer = false;
}

// Put my microphone on the connection (if it isn't already there).
function addLocalTracks() {
  if (!micOn || !localStream) return;
  ensurePeerConnection();
  localStream.getTracks().forEach((track) => {
    if (!pc.getSenders().some((s) => s.track === track)) pc.addTrack(track, localStream);
  });
}

// (Re)start the voice link with the friend after either of us (re)joined.
// Exactly one side — the "impolite" one — offers immediately; the other waits a
// moment for that offer. Two sides offering at the very same instant forces one
// of them to roll back, and Chrome's ICE gathering can get stuck after such a
// rollback (voice then never connects). If the other side turns out not to
// offer (e.g. its mic is off), we offer ourselves after the short wait.
function startVoiceIfNeeded() {
  if (!micOn || !localStream || !otherPeerId) return;
  clearTimeout(politeOfferTimer);
  if (!isPolite()) {
    addLocalTracks();
  } else {
    politeOfferTimer = setTimeout(() => {
      if (micOn && localStream && otherPeerId) addLocalTracks();
    }, 1200);
  }
}

function maybeStartNegotiation() {
  // The friend just (re)joined while my mic may be on.
  startVoiceIfNeeded();
}

// Safety net: if the voice link hasn't come up after a while (or has failed),
// rebuild it — at most twice, so a network that simply blocks direct
// connections doesn't loop forever.
function armVoiceWatchdog() {
  clearTimeout(voiceWatchdog);
  voiceWatchdog = setTimeout(() => {
    if (pc && micOn && otherPeerId && pc.connectionState !== "connected") rebuildVoice();
  }, 9000 + (isPolite() ? 2500 : 0));
}

function rebuildVoice() {
  if (!micOn || !otherPeerId || voiceRetries >= 2) return;
  voiceRetries++;
  addSystemMessage("ভয়েস সংযোগ জোড়া লাগেনি, আবার চেষ্টা করা হচ্ছে…");
  teardownPeerConnection();
  startVoiceIfNeeded();
}

// "Polite" peer = the one with the lexicographically larger socket id.
// Determined once we know both ids; avoids both sides offering simultaneously.
function isPolite() {
  if (!otherPeerId) return true;
  return socket.id > otherPeerId;
}

// Handle voice signals strictly one after another, so e.g. an ICE candidate is
// never processed while the description it belongs to is still being applied.
let signalChain = Promise.resolve();
socket.on("webrtc-signal", (msg) => {
  signalChain = signalChain
    .then(() => handleSignal(msg))
    .catch((err) => console.error("WebRTC signaling error:", err));
});

async function handleSignal({ from, type, description, candidate }) {
  otherPeerId = otherPeerId || from;
  ensurePeerConnection();
  const conn = pc;

  if (type === "description") {
    const offerCollision = description.type === "offer" && (makingOffer || conn.signalingState !== "stable");
    ignoreOffer = !isPolite() && offerCollision;
    if (ignoreOffer) return;

    await conn.setRemoteDescription(description);
    if (description.type === "offer") {
      // Answering: add my own mic now, so my answer carries my audio too
      // instead of needing a second round of negotiation afterwards.
      if (micOn && localStream) {
        localStream.getTracks().forEach((t) => {
          if (!conn.getSenders().some((s) => s.track === t)) conn.addTrack(t, localStream);
        });
      }
      await conn.setLocalDescription();
      if (pc === conn) socket.emit("webrtc-signal", { type: "description", description: conn.localDescription });
    }
  } else if (type === "candidate") {
    try {
      await conn.addIceCandidate(candidate);
    } catch (err) {
      if (!ignoreOffer) throw err;
    }
  }
}

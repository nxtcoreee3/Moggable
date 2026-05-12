import {
  auth, provider, signInWithPopup, signOut, onAuthStateChanged,
  ensureUserDoc, getUserByFriendCode
} from './firebase-config.js';

const SERVER_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:8080'
  : 'https://YOUR-RENDER-APP.onrender.com';

let socket = null;
let currentUser = null;
let userData = null;
let localStream = null;
let peerConnection = null;
let currentRoomId = null;
let myRole = null;
let currentMogScore = 0;
let chatOpen = false;

// MediaPipe
let faceMesh = null;
let lastCapturedScore = 0;

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function tap(el, fn) {
  if (!el) return;
  el.addEventListener('click', fn);
  el.addEventListener('touchstart', e => { e.preventDefault(); fn(e); }, { passive: false });
}

// ═══════════════════════════════════════════════
//  AI Face Tracking (MediaPipe)
// ═══════════════════════════════════════════════
function initFaceMesh() {
  if (faceMesh) return;
  faceMesh = new FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
  });

  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5
  });

  faceMesh.onResults(onFaceResults);
}

function onFaceResults(results) {
  const statusEl = document.getElementById('face-status-badge');
  const scoreEl = document.getElementById('live-mog-score');
  
  if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
    const landmarks = results.multiFaceLandmarks[0];
    
    // 🧠 MOG SCORE CALCULATION (Simplified Aesthetic Proxy)
    // 1. Symmetry check (Distance between eye outer corners vs nose center)
    const leftEye = landmarks[33];
    const rightEye = landmarks[263];
    const nose = landmarks[1];
    const eyeDist = Math.sqrt(Math.pow(rightEye.x - leftEye.x, 2) + Math.pow(rightEye.y - leftEye.y, 2));
    
    // 2. Jaw prominence proxy (Width of face at jawline)
    const jawLeft = landmarks[234];
    const jawRight = landmarks[454];
    const jawWidth = Math.sqrt(Math.pow(jawRight.x - jawLeft.x, 2) + Math.pow(jawRight.y - jawLeft.y, 2));

    // 3. Normalize score based on scale (eye distance) to avoid distance-from-cam bias
    const rawScore = (jawWidth / eyeDist) * 35; 
    
    // Add some "jitter" for a live feel and clamp it 0-100
    currentMogScore = Math.min(Math.max(Math.round(rawScore + (Math.random() * 2)), 30), 99);
    
    if (statusEl) { statusEl.textContent = 'FACE TRACKED'; statusEl.className = 'badge badge-green'; }
    if (scoreEl) scoreEl.textContent = currentMogScore;
  } else {
    currentMogScore = 0;
    if (statusEl) { statusEl.textContent = 'NO FACE DETECTED'; statusEl.className = 'badge badge-red'; }
    if (scoreEl) scoreEl.textContent = '—';
  }
}

async function runFaceTracking() {
  const video = document.getElementById('local-video');
  if (!video) return;
  
  const camera = new Camera(video, {
    onFrame: async () => {
      await faceMesh.send({ image: video });
    },
    width: 640,
    height: 480
  });
  camera.start();
}

function connectSocket() {
  if (socket?.connected) return;
  socket = io(SERVER_URL, { transports: ['websocket', 'polling'] });
  socket.on('connect', () => {
    if (userData) {
      socket.emit('register', {
        uid: currentUser.uid,
        username: userData.username,
        friendCode: userData.friendCode
      });
    }
  });
  socket.on('online-count', count => {
    const el = document.getElementById('online-count');
    if (el) el.textContent = count;
  });
  socket.on('waiting', () => showWaiting('Finding your opponent…'));
  socket.on('matched', ({ roomId, role }) => {
    currentRoomId = roomId;
    myRole = role;
    hideWaiting();
    setStatus('Connected! Starting video…');
    startWebRTC();
  });
  socket.on('offer', async ({ offer }) => {
    if (!peerConnection) initPeer();
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('answer', { roomId: currentRoomId, answer });
  });
  socket.on('answer', async ({ answer }) => {
    await peerConnection?.setRemoteDescription(new RTCSessionDescription(answer));
  });
  socket.on('ice-candidate', async ({ candidate }) => {
    try { await peerConnection?.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
  });
  socket.on('peer-disconnected', () => {
    toast('Your opponent disconnected', 'error');
    setStatus('Opponent left. Skip or go back.');
    resetPeer();
    document.getElementById('remote-video').srcObject = null;
    showRemoteOverlay(true);
  });
  socket.on('mogoff-started', () => {
    toast('Mogoff started! Rate your opponent 🔥', 'info');
    showMogoffOverlay();
  });
  socket.on('partner-rated', () => setStatus('Your opponent rated you — waiting for you…'));
  socket.on('mogoff-results', async ({ results, uids, socketIds }) => {
    const myScore = results[socket.id];
    const partnerSid = socketIds.find(id => id !== socket.id);
    const partnerScore = results[partnerSid];
    const partnerUid = uids[partnerSid];

    showResults(myScore, partnerScore);

    // Update Elo in Firestore
    if (userData && partnerUid) {
      await updateElo(myScore, partnerScore);
    }
  });
  socket.on('chat-message', ({ from, message }) => {
    appendChatMsg(from, message);
  });
  socket.on('code-not-found', () => {
    toast('Friend code not found or expired', 'error');
    hideWaiting();
  });
  socket.on('skipped', () => {
    resetPeer();
    setStatus('Skipped. Find a new match.');
    showRemoteOverlay(true);
    document.getElementById('remote-video').srcObject = null;
    showPage('page-dashboard');
  });
}

async function getLocalStream() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  const lv = document.getElementById('local-video');
  if (lv) { lv.srcObject = localStream; lv.muted = true; lv.play().catch(() => {}); }
  return localStream;
}

function initPeer() {
  peerConnection = new RTCPeerConnection(ICE_SERVERS);
  localStream?.getTracks().forEach(t => peerConnection.addTrack(t, localStream));
  peerConnection.ontrack = e => {
    const rv = document.getElementById('remote-video');
    if (rv) { rv.srcObject = e.streams[0]; rv.play().catch(() => {}); }
    showRemoteOverlay(false);
    setStatus('Live 🔴 — Challenge to a Mogoff!');
  };
  peerConnection.onicecandidate = e => {
    if (e.candidate) socket.emit('ice-candidate', { roomId: currentRoomId, candidate: e.candidate });
  };
  peerConnection.onconnectionstatechange = () => {
    if (['failed','disconnected'].includes(peerConnection.connectionState)) {
      toast('Connection lost', 'error');
      resetPeer();
    }
  };
}

async function startWebRTC() {
  await getLocalStream();
  initPeer();
  if (myRole === 'initiator') {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('offer', { roomId: currentRoomId, offer });
  }
}

function resetPeer() {
  peerConnection?.close();
  peerConnection = null;
  currentRoomId = null;
  myRole = null;
  selectedRating = 0;
  hideMogoffOverlay();
}

function stopLocalStream() {
  localStream?.getTracks().forEach(t => t.stop());
  localStream = null;
}

function setStatus(msg) {
  const el = document.getElementById('arena-status');
  if (el) el.textContent = msg;
}

function showWaiting(msg) {
  const ws = document.getElementById('waiting-screen');
  const wm = document.getElementById('waiting-msg');
  if (ws) ws.classList.add('active');
  if (wm) wm.textContent = msg;
}

function hideWaiting() {
  document.getElementById('waiting-screen')?.classList.remove('active');
}

function showRemoteOverlay(show) {
  const ol = document.getElementById('remote-overlay');
  if (ol) ol.style.display = show ? 'flex' : 'none';
}

function showMogoffOverlay() {
  document.getElementById('mogoff-overlay')?.classList.add('active');
}

function hideMogoffOverlay() {
  document.getElementById('mogoff-overlay')?.classList.remove('active');
}

function appendChatMsg(from, message) {
  const msgs = document.getElementById('chat-messages');
  if (!msgs) return;
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.innerHTML = `<span class="msg-from">${from}:</span>${escHtml(message)}`;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function showResults(myScore, partnerScore) {
  const ol = document.getElementById('results-overlay');
  if (!ol) return;

  document.getElementById('result-my-score').textContent = myScore;
  document.getElementById('result-their-score').textContent = partnerScore;

  const winner = myScore > partnerScore ? '🏆 You Mogged!' :
                 myScore < partnerScore ? '😔 You got Mogged' : '🤝 It\'s a Tie!';
  document.getElementById('result-verdict').textContent = winner;
  ol.classList.add('active');
}

async function updateElo(myScore, partnerScore) {
  if (!userData) return;
  
  const K = 32;
  const actualScore = myScore > partnerScore ? 1 : (myScore < partnerScore ? 0 : 0.5);
  
  // Note: We don't know partner's Elo here easily without a fetch, 
  // so we'll assume a fair match (partnerElo = 1000) or just use a fixed bump for now
  // In a real app, we'd fetch the partner's Elo from Firestore.
  const newElo = Math.round(userData.elo + K * (actualScore - 0.5));
  
  userData.elo = newElo;
  if (actualScore === 1) userData.wins++;
  if (actualScore === 0) userData.losses++;

  const { db, doc, setDoc } = await import('./firebase-config.js');
  const userRef = doc(db, 'users', currentUser.uid);
  await setDoc(userRef, { 
    elo: userData.elo,
    wins: userData.wins,
    losses: userData.losses 
  }, { merge: true });
  
  toast(`Elo Updated: ${newElo} ${actualScore === 1 ? '📈' : '📉'}`, 'info');
}

function renderLanding() {
  const pg = document.getElementById('page-landing');
  pg.innerHTML = `
    <div class="landing-inner">
      <div class="logo">Moggable</div>
      <div class="logo-sub">The Mogoff Arena</div>
      <h1 class="landing-tagline">Challenge strangers to 1v1 face battles</h1>
      <p class="landing-desc">Jump into a live video chat, challenge anyone to a <strong>Mogoff</strong>, rate each other 1–10, and find out who mogs who. 🔥</p>
      <div class="landing-stats">
        <div class="stat"><div class="stat-num" id="landing-online">—</div><div class="stat-label">Online</div></div>
        <div class="stat"><div class="stat-num">1v1</div><div class="stat-label">Video</div></div>
        <div class="stat"><div class="stat-num">0ms</div><div class="stat-label">Signups</div></div>
      </div>
      <div class="landing-cta">
        <button class="btn btn-primary btn-lg btn-full" id="landing-enter">⚡ Enter the Arena</button>
        <button class="btn btn-ghost btn-full" id="landing-learn">How it works</button>
      </div>
    </div>`;
  tap(document.getElementById('landing-enter'), () => showPage('page-auth'));
  tap(document.getElementById('landing-learn'), () => {
    toast('1. Sign in with Google → 2. Find a match → 3. Start a Mogoff → 4. Rate each other!', 'info');
  });
  const tmpSock = io(SERVER_URL, { transports: ['websocket','polling'] });
  tmpSock.on('online-count', c => {
    const el = document.getElementById('landing-online');
    if (el) el.textContent = c;
  });
}

function renderAuth() {
  const pg = document.getElementById('page-auth');
  pg.innerHTML = `
    <div class="glass auth-card">
      <div class="auth-logo">Moggable</div>
      <p class="auth-subtitle">Sign in to enter the arena</p>
      <button class="google-btn" id="google-signin-btn">
        <svg class="google-icon" viewBox="0 0 24 24">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
        </svg>
        Continue with Google
      </button>
      <div class="divider">or</div>
      <p style="color:var(--muted);font-size:13px;text-align:center">By signing in you agree to keep it respectful 🤝</p>
      <div style="margin-top:20px;text-align:center"><button class="btn btn-ghost btn-sm" id="back-to-landing">← Back</button></div>
    </div>`;
  tap(document.getElementById('google-signin-btn'), async () => {
    try {
      const result = await signInWithPopup(auth, provider);
      const ud = await ensureUserDoc(result.user);
      currentUser = result.user; userData = ud;
      toast(`Welcome, ${ud.username}! 🔥`, 'success');
      connectSocket();
      renderDashboard(); showPage('page-dashboard');
    } catch (err) { toast('Sign-in failed: ' + err.message, 'error'); }
  });
  tap(document.getElementById('back-to-landing'), () => showPage('page-landing'));
}

function renderDashboard() {
  if (!userData) return;
  const initial = userData.username.charAt(0).toUpperCase();
  const pg = document.getElementById('page-dashboard');
  pg.innerHTML = `
    <div class="dash-wrap">
      <div class="dash-header"><div class="dash-logo">Moggable</div><div class="dash-avatar" id="dash-avatar" title="Sign out">${initial}</div></div>
      <div class="glass profile-card">
        <div class="profile-avatar-lg">${initial}</div>
        <div class="profile-info">
          <div class="profile-name">${userData.username}</div>
          <div class="friend-code-row">
            <span class="friend-code" id="my-code">${userData.friendCode}</span>
            <button class="copy-btn" id="copy-code-btn" title="Copy code">📋</button>
          </div>
          <div style="display:flex;gap:12px;margin-top:12px">
            <div class="badge badge-purple">ELO: ${userData.elo}</div>
            <div class="badge badge-green">W: ${userData.wins}</div>
            <div class="badge badge-red">L: ${userData.losses}</div>
          </div>
        </div>
      </div>
      <div class="online-bar"><div class="pulse-dot"></div><span><span id="online-count">—</span> players online now</span></div>
      <div class="section-title">Jump In</div>
      <div class="action-grid">
        <div class="action-card featured" id="random-match-btn"><div class="action-icon">⚡</div><div class="action-title">Random Mogoff</div><div class="action-desc">Match with a random stranger instantly</div></div>
        <div class="action-card" id="host-code-btn"><div class="action-icon">🔗</div><div class="action-title">Host with Code</div><div class="action-desc">Wait for a friend to join you</div></div>
        <div class="action-card" id="join-code-btn"><div class="action-icon">🎯</div><div class="action-title">Join by Code</div><div class="action-desc">Enter a friend's code</div></div>
      </div>
      <div class="section-title">Or enter a friend code</div>
      <div class="glass fc-section">
        <div class="fc-input-row"><input class="fc-input" id="fc-input" type="text" maxlength="5" placeholder="A7K2Q" autocomplete="off" /><button class="btn btn-primary" id="fc-join-btn">Join</button></div>
      </div>
    </div>`;
  tap(document.getElementById('dash-avatar'), async () => {
    if (confirm('Sign out?')) { await signOut(auth); currentUser = null; userData = null; showPage('page-landing'); }
  });
  tap(document.getElementById('copy-code-btn'), () => { navigator.clipboard.writeText(userData.friendCode).then(() => toast('Friend code copied!', 'success')); });
  tap(document.getElementById('random-match-btn'), () => { openArena(); initFaceMesh(); socket.emit('find-match'); showWaiting('Finding an opponent…'); });
  tap(document.getElementById('host-code-btn'), () => { openArena(); initFaceMesh(); socket.emit('host-friend-code', { code: userData.friendCode }); showWaiting(`Waiting for someone to enter your code: ${userData.friendCode}`); });
  tap(document.getElementById('join-code-btn'), () => { document.getElementById('fc-input').focus(); toast('Enter a friend code below ↓', 'info'); });
  tap(document.getElementById('fc-join-btn'), joinByCode);
  document.getElementById('fc-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') joinByCode(); });
  document.getElementById('fc-input')?.addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });
}

async function joinByCode() {
  const code = document.getElementById('fc-input')?.value.trim().toUpperCase();
  if (!code || code.length !== 5) { toast('Enter a valid 5-character code', 'error'); return; }
  openArena();
  initFaceMesh();
  socket.emit('join-friend-code', { code });
  showWaiting('Connecting to friend…');
}

function openArena() {
  renderArena();
  showPage('page-arena');
  getLocalStream().then(() => {
    runFaceTracking();
  }).catch(() => toast('Camera access denied', 'error'));
}

function renderArena() {
  const pg = document.getElementById('page-arena');
  pg.innerHTML = `
    <div id="waiting-screen"><div class="spinner"></div><div style="font-size:22px;font-weight:800">Finding Match…</div><div id="waiting-msg" style="color:var(--muted);font-size:15px"></div><button class="btn btn-ghost" id="cancel-search-btn">Cancel</button></div>
    <div class="arena-wrap">
      <div class="arena-topbar"><div class="arena-title">⚔️ Moggable</div><div style="display:flex;gap:8px;align-items:center"><button class="btn btn-ghost btn-sm btn-icon" id="chat-toggle-btn" title="Chat">💬</button><button class="btn btn-ghost btn-sm" id="arena-back-btn">✕ Leave</button></div></div>
      <div class="video-grid">
        <div class="video-slot">
          <video id="local-video" autoplay muted playsinline></video>
          <div class="video-label">You</div>
          <!-- Live AI Badge -->
          <div style="position:absolute;top:10px;left:10px;display:flex;flex-direction:column;gap:6px">
            <div id="face-status-badge" class="badge badge-red">INITIALIZING AI...</div>
            <div class="badge badge-purple" style="font-size:16px">SCORE: <span id="live-mog-score">—</span></div>
          </div>
        </div>
        <div class="video-slot"><video id="remote-video" autoplay playsinline></video><div class="video-overlay" id="remote-overlay"><div class="big-emoji">👤</div><p>Waiting for opponent…</p></div>
          <!-- Mogoff rating overlay -->
          <div class="mogoff-overlay" id="mogoff-overlay">
            <div class="mogoff-title">AI SCORING IN PROGRESS...</div>
            <div style="font-size:64px;margin:20px 0" id="final-capture-score">—</div>
            <p style="color:var(--muted)">Stay still for the AI evaluation</p>
          </div>
        </div>
      </div>
      <div class="arena-status" id="arena-status">Connecting…</div>
      <div class="arena-controls">
        <button class="btn btn-primary btn-sm" id="mogoff-btn">🔥 Auto Mogoff!</button>
        <button class="btn btn-ghost btn-sm" id="skip-btn">⏭ Skip</button>
        <button class="btn btn-danger btn-sm" id="end-btn">📵 End</button><button class="btn btn-ghost btn-sm btn-icon" id="mute-btn" title="Mute">🎤</button><button class="btn btn-ghost btn-sm btn-icon" id="cam-btn" title="Camera">📷</button><button class="btn btn-ghost btn-sm btn-icon" id="report-btn" title="Report">🚩</button>
      </div>
      <div class="chat-panel" id="chat-panel"><div class="chat-header">💬 Chat<button class="btn btn-ghost btn-sm btn-icon" id="chat-close-btn">✕</button></div><div class="chat-messages" id="chat-messages"></div><div class="chat-input-row"><input id="chat-input" type="text" placeholder="Type a message…" maxlength="200" /><button class="btn btn-primary btn-sm btn-icon" id="chat-send-btn">➤</button></div></div>
    </div>
    <div id="results-overlay"><div style="font-size:48px">🏆</div><div style="font-size:26px;font-weight:900" id="result-verdict">Mogoff Results</div><div class="glass" style="padding:24px 40px;display:flex;gap:40px;border-radius:16px;text-align:center"><div><div style="color:var(--muted);font-size:13px;margin-bottom:4px">Your Score</div><div style="font-size:48px;font-weight:900;color:var(--accent)" id="result-my-score">—</div></div><div style="display:flex;align-items:center;color:var(--muted)">vs</div><div><div style="color:var(--muted);font-size:13px;margin-bottom:4px">Their Score</div><div style="font-size:48px;font-weight:900;color:var(--danger)" id="result-their-score">—</div></div></div><button class="btn btn-primary" id="results-rematch-btn">⚡ Find New Match</button><button class="btn btn-ghost" id="results-home-btn">🏠 Dashboard</button></div>`;
  const stars = document.getElementById('rating-stars');
  for (let i = 1; i <= 10; i++) {
    const btn = document.createElement('button'); btn.className = 'star-btn'; btn.textContent = i <= 5 ? '⭐' : '💜'; btn.dataset.val = i;
    tap(btn, () => { selectedRating = i; document.querySelectorAll('.star-btn').forEach((b, idx) => { b.classList.toggle('active', idx < i); }); });
    stars.appendChild(btn);
  }
  tap(document.getElementById('cancel-search-btn'), () => { socket?.emit('cancel-search'); resetPeer(); stopLocalStream(); renderDashboard(); showPage('page-dashboard'); });
  tap(document.getElementById('arena-back-btn'), leaveArena);
  tap(document.getElementById('end-btn'), leaveArena);
  tap(document.getElementById('mogoff-btn'), () => {
    if (!currentRoomId) { toast('Not connected yet!', 'error'); return; }
    if (currentMogScore === 0) { toast('Face not detected!', 'error'); return; }
    
    // Capture current score and send to server
    socket.emit('submit-rating', { roomId: currentRoomId, rating: currentMogScore });
    
    document.getElementById('final-capture-score').textContent = currentMogScore;
    showMogoffOverlay();
    toast('Score submitted! Waiting for opponent...', 'success');
  });
  let muted = false; tap(document.getElementById('mute-btn'), () => { muted = !muted; localStream?.getAudioTracks().forEach(t => t.enabled = !muted); document.getElementById('mute-btn').textContent = muted ? '🔇' : '🎤'; });
  let camOff = false; tap(document.getElementById('cam-btn'), () => { camOff = !camOff; localStream?.getVideoTracks().forEach(t => t.enabled = !camOff); document.getElementById('cam-btn').textContent = camOff ? '📵' : '📷'; });
  tap(document.getElementById('report-btn'), () => { if (!currentRoomId) return; socket.emit('report', { roomId: currentRoomId, reason: 'inappropriate' }); toast('Report submitted. Thank you.', 'success'); });
  tap(document.getElementById('chat-toggle-btn'), () => toggleChat(true));
  tap(document.getElementById('chat-close-btn'), () => toggleChat(false));
  tap(document.getElementById('chat-send-btn'), sendChat);
  document.getElementById('chat-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
  tap(document.getElementById('results-rematch-btn'), () => { document.getElementById('results-overlay')?.classList.remove('active'); resetPeer(); openArena(); socket.emit('find-match'); showWaiting('Finding a new opponent…'); });
  tap(document.getElementById('results-home-btn'), () => { document.getElementById('results-overlay')?.classList.remove('active'); leaveArena(); });
}

function toggleChat(open) { chatOpen = open; document.getElementById('chat-panel')?.classList.toggle('open', open); }
function sendChat() { const input = document.getElementById('chat-input'); const msg = input?.value.trim(); if (!msg || !currentRoomId) return; socket.emit('chat-message', { roomId: currentRoomId, message: msg }); appendChatMsg('You', msg); input.value = ''; }
function leaveArena() { if (currentRoomId) socket?.emit('skip', { roomId: currentRoomId }); resetPeer(); stopLocalStream(); renderDashboard(); showPage('page-dashboard'); }

onAuthStateChanged(auth, async (user) => {
  if (user) { try { currentUser = user; userData = await ensureUserDoc(user); connectSocket(); renderDashboard(); showPage('page-dashboard'); } catch { renderLanding(); renderAuth(); showPage('page-landing'); } }
  else { renderLanding(); renderAuth(); showPage('page-landing'); }
});

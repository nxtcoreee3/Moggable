import {
  auth, provider, signInWithPopup, signOut, onAuthStateChanged,
  ensureUserDoc, getUserByFriendCode
} from './firebase-config.js';

const SERVER_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:8080'
  : (localStorage.getItem('MOGGABLE_SERVER_URL') || 'https://moggable.onrender.com');

let socket = null;
let currentUser = null;
let userData = null;
let isGuest = false;
let isVerified = false;
let localStream = null;
let peerConnection = null;
let currentRoomId = null;
let myRole = null;
let currentMogScore = 0;
let chatOpen = false;
let isDeafened = localStorage.getItem('MOGGABLE_DEAFENED') === 'true';
let isMuted = localStorage.getItem('MOGGABLE_MUTED') === 'true';
let matchTimer = null;
let timeLeft = 0;
let hasOvertime = false;
let cameraOffStart = null;
let remoteScore = "0.0";
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
  const canvasElement = document.getElementById('local-canvas');
  if (!canvasElement) return;
  const canvasCtx = canvasElement.getContext('2d');
  
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);

  if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
    const landmarks = results.multiFaceLandmarks[0];
    
    // 🎨 DRAW MESH (10% Opacity Connectors)
    canvasCtx.globalAlpha = 0.1;
    if (window.drawConnectors && window.FACEMESH_TESSELATION) {
      drawConnectors(canvasCtx, landmarks, FACEMESH_TESSELATION, {color: '#00FFC8', lineWidth: 0.5});
    }
    
    // 🎨 DRAW WAYPOINTS (100% Opacity Points)
    canvasCtx.globalAlpha = 1.0;
    canvasCtx.fillStyle = '#00FFC8';
    const waypoints = [33, 133, 362, 263, 1, 61, 291, 199, 10, 152, 234, 454]; // Eyes, nose, mouth, chin, jaw
    for (const idx of waypoints) {
      const pt = landmarks[idx];
      canvasCtx.beginPath();
      canvasCtx.arc(pt.x * canvasElement.width, pt.y * canvasElement.height, 2, 0, 2 * Math.PI);
      canvasCtx.fill();
    }
    
    // 🧠 MOG SCORE CALCULATION (Scaled 1.0 - 10.0 - Improved Range)
    const leftEye = landmarks[33];
    const rightEye = landmarks[263];
    const eyeDist = Math.sqrt(Math.pow(rightEye.x - leftEye.x, 2) + Math.pow(rightEye.y - leftEye.y, 2));
    const jawLeft = landmarks[234];
    const jawRight = landmarks[454];
    const jawWidth = Math.sqrt(Math.pow(jawRight.x - jawLeft.x, 2) + Math.pow(jawRight.y - jawLeft.y, 2));

    const ratio = jawWidth / eyeDist;
    const base = (ratio - 1.2) * 8 + 3.0; 
    currentMogScore = Math.min(Math.max((base + (Math.random() * 0.1)).toFixed(1), 1.0), 10.0);
    
    // 🔍 FACE ANALYSIS (DOM & FLAW)
    let dom = "Strong Jawline";
    let flaw = "Neutral Tilt";
    
    // Canthal Tilt logic
    const innerEye = landmarks[133];
    const outerEye = landmarks[33];
    const tilt = (innerEye.y - outerEye.y);
    if (tilt > 0.005) flaw = "Negative Tilt";
    else if (tilt < -0.005) dom = "Hunter Eyes";
    
    if (ratio < 1.4) flaw = "Weak Jawline";
    else if (ratio > 1.8) dom = "Alpha Jawline";

    if (statusEl) { statusEl.textContent = 'SCANNING...'; statusEl.className = 'status-pill active'; }
    if (scoreEl) scoreEl.textContent = currentMogScore;
    
    const domEl = document.getElementById('live-dom');
    const flawEl = document.getElementById('live-flaw');
    if (domEl) domEl.textContent = dom;
    if (flawEl) flawEl.textContent = flaw;
  } else {
    currentMogScore = "0.0";
    if (statusEl) { statusEl.textContent = 'FACE NOT FOUND'; statusEl.className = 'status-pill inactive'; }
    if (scoreEl) scoreEl.textContent = '0.0';
  }
}

async function runFaceTracking(onVerified = null) {
  const video = document.getElementById('local-video') || document.getElementById('liveness-video');
  if (!video) return;
  
  if (!faceMesh) initFaceMesh();

  // If we are doing liveness check, we need a different callback
  if (onVerified) {
    faceMesh.onResults((results) => onLivenessResults(results, onVerified));
  } else {
    faceMesh.onResults(onFaceResults);
  }

  const camera = new Camera(video, {
    onFrame: async () => {
      await faceMesh.send({ image: video });
    },
    width: 640,
    height: 480
  });
  camera.start();
  return camera;
}

let livenessState = 'center'; // center -> left -> right -> done

function onLivenessResults(results, onVerified) {
  const instructionEl = document.getElementById('liveness-instruction');
  const progressEl = document.getElementById('liveness-progress-fill');

  if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
    const landmarks = results.multiFaceLandmarks[0];
    const nose = landmarks[1];
    const leftEye = landmarks[33];
    const rightEye = landmarks[263];
    
    // Calculate Yaw (approximate)
    const midPoint = (leftEye.x + rightEye.x) / 2;
    const yaw = (nose.x - midPoint) / (rightEye.x - leftEye.x);

    if (livenessState === 'center') {
      instructionEl.textContent = 'Look straight at the camera';
      if (Math.abs(yaw) < 0.1) {
        livenessState = 'left';
        toast('Good! Now turn your head LEFT', 'info');
      }
    } else if (livenessState === 'left') {
      instructionEl.textContent = 'Turn your head LEFT ←';
      if (yaw < -0.4) {
        livenessState = 'right';
        toast('Perfect! Now turn your head RIGHT', 'info');
      }
    } else if (livenessState === 'right') {
      instructionEl.textContent = 'Turn your head RIGHT →';
      if (yaw > 0.4) {
        livenessState = 'done';
        isVerified = true;
        instructionEl.textContent = 'Verification Complete! ✅';
        instructionEl.style.color = 'var(--success)';
        setTimeout(onVerified, 1000);
      }
    }
    
    // Update progress
    let p = 0;
    if (livenessState === 'left') p = 33;
    if (livenessState === 'right') p = 66;
    if (livenessState === 'done') p = 100;
    if (progressEl) progressEl.style.width = p + '%';

  } else {
    if (instructionEl) instructionEl.textContent = 'Position your face in the frame';
  }
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
  socket.on('match-found', async ({ roomId, partner, role }) => {
    currentRoomId = roomId;
    myRole = role;
    toast(`Match Found: ${partner.username}`, 'success');
    hideWaiting();
    document.getElementById('remote-overlay')?.remove();
    startMatchTimer(20);
    
    // Initial status sync
    socket.emit('status-update', { roomId, status: { muted: isMuted, deafened: isDeafened, cameraOff: false } });
    
    startLocalStream().then(stream => {
      createPeerConnection();
      stream.getTracks().forEach(track => peerConnection.addTrack(track, stream));
    });
  });

  socket.on('status-update', ({ status }) => {
    updateRemoteStatus(status);
  });

  socket.on('opponent-rating', ({ rating }) => {
    remoteScore = rating;
    const el = document.getElementById('remote-mog-score');
    if (el) el.textContent = rating;
  });
  socket.on('mogoff-started', () => {
    toast('Mogoff started! Rate your opponent 🔥', 'info');
    showMogoffOverlay();
  });
  socket.on('partner-rated', () => setStatus('Your opponent rated you — waiting for you…'));
  socket.on('mogoff-results', async ({ results, uids, socketIds }) => {
    if (matchTimer) clearInterval(matchTimer);
    const myScore = results[socket.id];
    const partnerSid = socketIds.find(id => id !== socket.id);
    const partnerScore = results[partnerSid];
    
    showResults(myScore, partnerScore);
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

async function startLocalStream() {
  const constraints = { video: true, audio: !isDeafened && !isMuted };
  return navigator.mediaDevices.getUserMedia(constraints).then(stream => {
    localStream = stream;
    const localVideo = document.getElementById('local-video');
    if (localVideo) localVideo.srcObject = stream;
    
    // Sync status if in a room
    if (currentRoomId) {
      socket.emit('status-update', { 
        roomId: currentRoomId, 
        status: { muted: isMuted, deafened: isDeafened, cameraOff: false } 
      });
    }
    return stream;
  }).catch(() => toast('Camera access denied', 'error'));
}

function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(track => track.enabled = !isMuted);
  toast(isMuted ? 'Microphone Muted' : 'Microphone Active', 'info');
  if (currentRoomId) {
    socket.emit('status-update', { 
      roomId: currentRoomId, 
      status: { muted: isMuted, deafened: isDeafened, cameraOff: !localStream.getVideoTracks()[0].enabled } 
    });
  }
}

function toggleCam() {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  track.enabled = !track.enabled;
  toast(track.enabled ? 'Camera On' : 'Camera Off', 'info');
  if (currentRoomId) {
    socket.emit('status-update', { 
      roomId: currentRoomId, 
      status: { muted: isMuted, deafened: isDeafened, cameraOff: !track.enabled } 
    });
  }
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

  const myS = parseFloat(myScore);
  const pS = parseFloat(partnerScore);
  const diff = Math.abs(myS - pS);
  
  document.getElementById('result-my-score').textContent = myS.toFixed(1);
  document.getElementById('result-their-score').textContent = pS.toFixed(1);

  let verdict = "";
  let subtext = "";
  let color = "var(--text)";

  if (myS > pS) {
    if (diff < 0.5) {
      verdict = "EDGED";
      subtext = "THEY COULDN'T COMPETE";
      color = "#22d3ee";
    } else if (diff < 1.5) {
      verdict = "MOGGED";
      subtext = "CLEAR DOMINANCE";
      color = "#c084fc";
    } else {
      verdict = "BRUTALIZED";
      subtext = "ABSOLUTE ANNIHILATION";
      color = "#f43f5e";
    }
  } else if (pS > myS) {
    if (diff < 0.5) {
      verdict = "EDGED";
      subtext = "YOU COULDN'T COMPETE";
      color = "var(--muted)";
    } else if (diff < 1.5) {
      verdict = "MOGGED";
      subtext = "YOU GOT OVERPOWERED";
      color = "var(--danger)";
    } else {
      verdict = "BRUTALIZED";
      subtext = "YOU WERE ANNIHILATED";
      color = "var(--danger)";
    }
  } else {
    verdict = "TIED";
    subtext = "A PERFECT MATCH";
    color = "#fff";
  }

  const verdictEl = document.getElementById('result-verdict');
  verdictEl.textContent = verdict;
  verdictEl.style.color = color;
  verdictEl.style.fontSize = "72px";
  verdictEl.style.letterSpacing = "0.1em";
  
  const subEl = document.getElementById('result-subtext') || document.createElement('div');
  subEl.id = 'result-subtext';
  subEl.textContent = subtext;
  subEl.style.color = "var(--muted)";
  subEl.style.fontSize = "14px";
  subEl.style.fontWeight = "800";
  subEl.style.marginTop = "-10px";
  subEl.style.textTransform = "uppercase";
  
  if (!document.getElementById('result-subtext')) {
    verdictEl.parentNode.insertBefore(subEl, verdictEl.nextSibling);
  }

  ol.classList.add('active');
}

async function updateElo(myScore, partnerScore, forfeit = false) {
  const myS = parseFloat(myScore);
  const pS = parseFloat(partnerScore);
  
  let actualScore = 0.5;
  if (forfeit) {
    actualScore = 0;
  } else {
    actualScore = myS > pS ? 1 : (myS < pS ? 0 : 0.5);
  }
  
  // Requirement: Change range 3 - 7
  const diff = Math.abs(myS - pS);
  let baseChange = 5;
  if (diff > 1.5) baseChange = 7;
  if (diff < 0.5) baseChange = 3;
  
  const eloChange = actualScore === 0.5 ? 0 : (actualScore === 1 ? baseChange : -baseChange);
  
  if (isGuest) {
    userData.elo = Math.max(0, userData.elo + eloChange);
    if (actualScore === 1) userData.wins++;
    if (actualScore === 0) userData.losses++;
    localStorage.setItem('MOGGABLE_GUEST_DATA', JSON.stringify(userData));
    toast(`Guest Elo: ${eloChange > 0 ? '+' : ''}${eloChange} ${actualScore === 1 ? '📈' : '📉'}`, 'info');
    return;
  }

  if (!userData) return;
  
  userData.elo += eloChange;
  if (actualScore === 1) userData.wins++;
  if (actualScore === 0) userData.losses++;

  const { db, doc, setDoc } = await import('./firebase-config.js');
  const userRef = doc(db, 'users', currentUser.uid);
  await setDoc(userRef, { 
    elo: userData.elo,
    wins: userData.wins,
    losses: userData.losses 
  }, { merge: true });
  
  toast(`Elo: ${eloChange > 0 ? '+' : ''}${eloChange} ${actualScore === 1 ? '📈' : '📉'}`, 'info');
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
        <button class="btn btn-ghost btn-full" id="landing-tutorial">How it works</button>
      </div>
    </div>`;
  tap(document.getElementById('landing-enter'), () => showPage('page-auth'));
  tap(document.getElementById('landing-tutorial'), renderTutorial);
  
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
      <button class="btn btn-ghost btn-full" id="guest-login-btn">⚡ Play as Guest</button>
      <p style="color:var(--muted);font-size:13px;text-align:center;margin-top:20px">By signing in you agree to keep it respectful 🤝</p>
      <div style="margin-top:20px;text-align:center"><button class="btn btn-ghost btn-sm" id="back-to-landing">← Back</button></div>
    </div>`;
  tap(document.getElementById('google-signin-btn'), async () => {
    try {
      const result = await signInWithPopup(auth, provider);
      const ud = await ensureUserDoc(result.user);
      currentUser = result.user; userData = ud; isGuest = false;
      toast(`Welcome, ${ud.username}! 🔥`, 'success');
      connectSocket();
      renderDashboard(); showPage('page-dashboard');
    } catch (err) { toast('Sign-in failed: ' + err.message, 'error'); }
  });
  tap(document.getElementById('guest-login-btn'), renderGuestSetup);
  tap(document.getElementById('back-to-landing'), () => showPage('page-landing'));
}

function renderGuestSetup() {
  const pg = document.getElementById('page-auth');
  pg.innerHTML = `
    <div class="glass auth-card">
      <div class="auth-logo">Guest Access</div>
      <p class="auth-subtitle">Choose an alias to start playing</p>
      <div style="margin-bottom:20px">
        <label>Display Name</label>
        <input type="text" id="guest-alias" placeholder="CoolMogger" maxlength="15" autocomplete="off" />
      </div>
      <button class="btn btn-primary btn-full" id="confirm-guest-btn">Enter Arena</button>
      <div style="margin-top:20px;text-align:center"><button class="btn btn-ghost btn-sm" id="back-to-auth">← Back</button></div>
    </div>`;
  
  const input = document.getElementById('guest-alias');
  input.focus();

  tap(document.getElementById('confirm-guest-btn'), () => {
    const alias = input.value.trim();
    if (!alias) { toast('Please enter an alias', 'error'); return; }
    
    const saved = localStorage.getItem('MOGGABLE_GUEST_DATA');
    let baseData = saved ? JSON.parse(saved) : { elo: 100, wins: 0, losses: 0 };
    
    isGuest = true;
    currentUser = { uid: 'guest_' + Math.random().toString(36).substr(2, 9) };
    userData = {
      ...baseData,
      uid: currentUser.uid,
      username: alias + ' (Guest)',
      friendCode: 'GUEST'
    };
    
    toast(`Welcome, ${alias}! Playing as Guest.`, 'success');
    connectSocket();
    renderDashboard(); showPage('page-dashboard');
  });

  tap(document.getElementById('back-to-auth'), renderAuth);
}

function renderSettings() {
  const pg = document.getElementById('page-dashboard');
  const modal = document.createElement('div');
  modal.className = 'glass modal';
  modal.innerHTML = `
    <div class="modal-header"><h2>Settings</h2><button class="btn btn-ghost btn-sm" id="close-settings">✕</button></div>
    <div class="settings-list">
      <div class="setting-item">
        <div class="setting-info"><div class="setting-title">Deafened Mode</div><div class="setting-desc">Mute all incoming and outgoing audio. Perfect for public places.</div></div>
        <label class="switch"><input type="checkbox" id="deafen-toggle" ${isDeafened ? 'checked' : ''} /><span class="slider"></span></label>
      </div>
      <div class="setting-item">
        <div class="setting-info"><div class="setting-title">Always Muted</div><div class="setting-desc">Start matches with your microphone disabled.</div></div>
        <label class="switch"><input type="checkbox" id="mute-toggle" ${isMuted ? 'checked' : ''} /><span class="slider"></span></label>
      </div>
      <div class="setting-item">
        <div class="setting-info"><div class="setting-title">Server URL</div><div class="setting-desc">Advanced: Change the matchmaking server.</div></div>
        <input type="text" id="server-url-input" value="${SERVER_URL}" style="font-size:12px;padding:8px" />
      </div>
    </div>
    <button class="btn btn-primary btn-full" id="save-settings" style="margin-top:20px">Save Settings</button>
  `;
  document.body.appendChild(modal);
  
  tap(document.getElementById('close-settings'), () => modal.remove());
  tap(document.getElementById('save-settings'), () => {
    isDeafened = document.getElementById('deafen-toggle').checked;
    isMuted = document.getElementById('mute-toggle').checked;
    const srv = document.getElementById('server-url-input').value.trim();
    localStorage.setItem('MOGGABLE_DEAFENED', isDeafened);
    localStorage.setItem('MOGGABLE_MUTED', isMuted);
    if (srv) localStorage.setItem('MOGGABLE_SERVER_URL', srv);
    toast('Settings saved!', 'success');
    modal.remove();
    location.reload(); // Reload to apply server changes
  });
}

function renderTutorial() {
  const pg = document.createElement('div');
  pg.className = 'glass modal tutorial-modal';
  pg.innerHTML = `
    <div class="modal-header"><h2>How to Mog</h2><button class="btn btn-ghost btn-sm" id="close-tutorial">✕</button></div>
    <div class="tutorial-steps">
      <div class="t-step"><div class="t-icon">👤</div><div class="t-title">Face Forward</div><p>Hold still, chin level, one face in frame for best scanning.</p></div>
      <div class="t-step"><div class="t-icon">🔥</div><div class="t-title">Auto Mogoff</div><p>Every match has a 20s timer. AI evaluates your face automatically when time's up.</p></div>
      <div class="t-step"><div class="t-icon">⚔️</div><div class="t-title">Overtime</div><p>If the match is too close (within 1.0 points), you get +10s of Overtime!</p></div>
      <div class="t-step"><div class="t-icon">📈</div><div class="t-title">Win to Climb</div><p>Beat stronger players for bigger ELO gains. Brutalize them for maximum reward.</p></div>
    </div>
    <button class="btn btn-primary btn-full" id="start-playing-btn">Understood</button>
  `;
  document.body.appendChild(pg);
  tap(document.getElementById('close-tutorial'), () => pg.remove());
  tap(document.getElementById('start-playing-btn'), () => pg.remove());
}

function renderDashboard() {
  if (!userData) return;
  const initial = userData.username.charAt(0).toUpperCase();
  const pg = document.getElementById('page-dashboard');
  pg.innerHTML = `
    <div class="dash-wrap">
      <div class="dash-header"><div class="dash-logo">Moggable</div><div style="display:flex;gap:12px"><button class="btn btn-ghost btn-sm btn-icon" id="dash-settings-btn" title="Settings">⚙️</button><div class="dash-avatar" id="dash-avatar" title="Sign out">${initial}</div></div></div>
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
    </div>`;
  tap(document.getElementById('dash-avatar'), async () => {
    if (confirm('Sign out?')) { await signOut(auth); currentUser = null; userData = null; showPage('page-landing'); }
  });
  tap(document.getElementById('dash-settings-btn'), renderSettings);
  tap(document.getElementById('copy-code-btn'), () => { navigator.clipboard.writeText(userData.friendCode).then(() => toast('Friend code copied!', 'success')); });
  tap(document.getElementById('random-match-btn'), () => {
    if (!isVerified) {
      renderLivenessCheck(() => {
        isVerified = true;
        openArena();
        socket.emit('find-match');
        showWaiting('Finding an opponent…');
      });
    } else {
      openArena();
      socket.emit('find-match');
      showWaiting('Finding an opponent…');
    }
  });
  tap(document.getElementById('host-code-btn'), () => {
    if (!isVerified) {
      renderLivenessCheck(() => {
        isVerified = true;
        openArena();
        socket.emit('host-friend-code', { code: userData.friendCode });
        showWaiting(`Waiting for someone to enter your code: ${userData.friendCode}`);
      });
    } else {
      openArena();
      socket.emit('host-friend-code', { code: userData.friendCode });
      showWaiting(`Waiting for someone to enter your code: ${userData.friendCode}`);
    }
  });
  tap(document.getElementById('join-code-btn'), () => { 
    const code = prompt('Enter Friend Code:');
    if (code) {
       document.getElementById('fc-input').value = code;
       if (!isVerified) renderLivenessCheck(() => { isVerified = true; joinByCode(); });
       else joinByCode();
    }
  });
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

function startMatchTimer(duration = 20) {
  if (matchTimer) clearInterval(matchTimer);
  timeLeft = duration;
  hasOvertime = false;
  
  const timerEl = document.getElementById('match-timer');
  const timerBar = document.getElementById('match-timer-fill');
  
  matchTimer = setInterval(() => {
    timeLeft--;
    if (timerEl) timerEl.textContent = timeLeft;
    if (timerBar) timerBar.style.width = (timeLeft / duration * 100) + '%';
    
    if (timeLeft <= 0) {
      if (!hasOvertime && Math.abs(parseFloat(currentMogScore) - parseFloat(remoteScore)) <= 1.0) {
        triggerOvertime();
      } else {
        autoMogoff();
      }
    }
  }, 1000);
}

function triggerOvertime() {
  hasOvertime = true;
  timeLeft = 10;
  clearInterval(matchTimer);
  toast('⚔️ OVERTIME! +10 SECONDS', 'info');
  const timerEl = document.getElementById('match-timer');
  if (timerEl) timerEl.style.color = 'var(--danger)';
  
  matchTimer = setInterval(() => {
    timeLeft--;
    if (timerEl) timerEl.textContent = timeLeft;
    if (timeLeft <= 0) autoMogoff();
  }, 1000);
}

function autoMogoff() {
  clearInterval(matchTimer);
  if (!currentRoomId) return;
  socket.emit('submit-rating', { roomId: currentRoomId, rating: currentMogScore });
  document.getElementById('final-capture-score').textContent = currentMogScore;
  showMogoffOverlay();
}

function updateRemoteStatus(status) {
  const badge = document.getElementById('remote-status-badges');
  if (!badge) return;
  badge.innerHTML = '';
  if (status.muted) badge.innerHTML += '<div class="badge badge-red">MUTED</div>';
  if (status.deafened) badge.innerHTML += '<div class="badge badge-purple">DEAFENED</div>';
  if (status.cameraOff) badge.innerHTML += '<div class="badge badge-red">CAM OFF</div>';
}

function checkCameraHealth() {
  const video = document.getElementById('local-video');
  if (!video || !currentRoomId) return;
  
  const isOff = video.paused || video.ended || !localStream?.getVideoTracks()[0]?.enabled;
  
  if (isOff) {
    if (!cameraOffStart) cameraOffStart = Date.now();
    const elapsed = (Date.now() - cameraOffStart) / 1000;
    if (elapsed > 5) {
      toast('Camera off for too long! Forfeiting...', 'error');
      leaveArena(true); // true means forfeit
    }
  } else {
    cameraOffStart = null;
  }
}
setInterval(checkCameraHealth, 1000);

function renderArena() {
  const pg = document.getElementById('page-arena');
  pg.innerHTML = `
    <div id="waiting-screen"><div class="spinner"></div><div style="font-size:22px;font-weight:800">Finding Match…</div><div id="waiting-msg" style="color:var(--muted);font-size:15px"></div><button class="btn btn-ghost" id="cancel-search-btn">Cancel</button></div>
    <div class="arena-wrap">
      <div class="arena-topbar">
        <div class="arena-title">⚔️ Moggable</div>
        <div class="match-timer-container">
          <div class="match-timer-val" id="match-timer">20</div>
          <div class="match-timer-bar"><div class="match-timer-fill" id="match-timer-fill"></div></div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn btn-ghost btn-sm btn-icon" id="chat-toggle-btn" title="Chat">💬</button>
          <button class="btn btn-ghost btn-sm" id="arena-back-btn">✕ Leave</button>
        </div>
      </div>
      <div class="video-grid">
        <div class="video-slot player-slot">
          <video id="local-video" autoplay muted playsinline></video>
          <canvas id="local-canvas" width="640" height="480"></canvas>
          <div class="scanline"></div>
          
          <div class="slot-overlay top-left">
            <div class="mog-score-card">
              <div class="mog-score-label">OVERALL SCORE</div>
              <div class="mog-score-val" id="live-mog-score">0.0</div>
              <div class="analysis-row"><span>DOM:</span> <span id="live-dom" style="color:var(--accent)">Scanning...</span></div>
              <div class="analysis-row"><span>FLAW:</span> <span id="live-flaw" style="color:var(--danger)">Scanning...</span></div>
              <div class="mog-score-sub"><span id="local-status-dot" style="color:var(--success)">●</span> SCANNING</div>
            </div>
          </div>

          <div class="slot-overlay top-right">
            <div class="scan-tag">YOUR SCAN</div>
          </div>

          <div class="slot-overlay bottom-right">
            <div class="player-info-card">
              <div class="player-name">${userData.username}</div>
              <div class="player-meta"><span class="badge badge-purple">${userData.elo} ELO</span></div>
            </div>
          </div>
          
          <div id="face-status-badge" class="status-pill">INITIALIZING...</div>
        </div>

        <div class="video-slot opponent-slot">
          <video id="remote-video" autoplay playsinline></video>
          <div class="scanline"></div>
          <div class="video-overlay" id="remote-overlay"><div class="big-emoji">👤</div><p>Searching for opponent…</p></div>
          
          <div class="slot-overlay top-left">
             <div class="mog-score-card">
              <div class="mog-score-label">OVERALL SCORE</div>
              <div class="mog-score-val" id="remote-mog-score">?.?</div>
              <div class="mog-score-sub">WAITING...</div>
            </div>
          </div>

          <div class="slot-overlay top-right">
            <div class="scan-tag">ENEMY SCAN</div>
            <div id="remote-status-badges" style="display:flex;gap:4px;margin-top:4px;justify-content:flex-end"></div>
          </div>

          <div class="mogoff-overlay" id="mogoff-overlay">
            <div class="mogoff-title">ANALYZING OPPONENT...</div>
            <div class="final-score-display" id="final-capture-score">?.?</div>
            <p style="color:var(--muted)">Stay still for AI evaluation</p>
          </div>
        </div>
      </div>
      <div class="arena-status" id="arena-status">Establishing connection...</div>
      <div class="arena-controls">
        <button class="btn btn-primary btn-sm" id="mogoff-btn">🔥 Auto Mogoff!</button>
        <button class="btn btn-ghost btn-sm" id="skip-btn">⏭ Skip</button>
        <button class="btn btn-danger btn-sm" id="end-btn">📵 End</button>
      </div>
      <div class="chat-panel" id="chat-panel"><div class="chat-header">💬 Chat<button class="btn btn-ghost btn-sm btn-icon" id="chat-close-btn">✕</button></div><div class="chat-messages" id="chat-messages"></div><div class="chat-input-row"><input id="chat-input" type="text" placeholder="Type a message…" maxlength="200" /><button class="btn btn-primary btn-sm btn-icon" id="chat-send-btn">➤</button></div></div>
    </div>
    <div id="results-overlay">
      <div style="font-size:72px;font-weight:900;margin-bottom:10px;text-shadow:0 0 30px currentColor" id="result-verdict">EDGED</div>
      <div id="result-subtext" style="color:var(--muted);font-size:14px;font-weight:800;margin-bottom:40px;text-transform:uppercase">THEY COULDN'T COMPETE</div>
      
      <div class="results-grid">
        <div class="result-card you-card">
          <div class="rc-label">YOU</div>
          <div class="rc-score" id="result-my-score">0.0</div>
        </div>
        <div class="result-card opponent-card">
          <div class="rc-label">OPPONENT</div>
          <div class="rc-score" id="result-their-score">0.0</div>
        </div>
      </div>

      <div class="results-actions">
        <button class="btn btn-success btn-full" id="results-rematch-btn">REMATCH & CHAT</button>
        <button class="btn btn-ghost btn-full" id="results-home-btn">RETURN TO MENU</button>
        <button class="btn btn-ghost btn-sm btn-full" style="color:var(--danger);opacity:0.6" id="results-report-btn">REPORT OPPONENT</button>
      </div>
    </div>`;
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
function leaveArena(isForfeit = false) {
  if (matchTimer) clearInterval(matchTimer);
  if (currentRoomId) {
    socket?.emit('skip', { roomId: currentRoomId });
    if (isForfeit) updateElo(0, 10, true);
  }
  resetPeer();
  stopLocalStream();
  renderDashboard();
  showPage('page-dashboard');
}

onAuthStateChanged(auth, async (user) => {
  if (user) { try { currentUser = user; userData = await ensureUserDoc(user); connectSocket(); renderDashboard(); showPage('page-dashboard'); } catch { renderLanding(); renderAuth(); showPage('page-landing'); } }
  else { renderLanding(); renderAuth(); showPage('page-landing'); }
});

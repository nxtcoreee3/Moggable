/**
 * Moggable - Signaling Server
 * Node.js + Express + Socket.IO
 * Handles: matchmaking, friend codes, WebRTC signaling
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ─── In-memory state ────────────────────────────────────────────────────────
const waitingQueue = [];          // sockets waiting for random match
const rooms = new Map();          // roomId → { users: [socketId, ...], ratings: {} }
const socketToRoom = new Map();   // socketId → roomId
const friendCodeSessions = new Map(); // friendCode → socketId (initiator waiting)
const onlineUsers = new Map();    // socketId → { uid, username, friendCode }

// ─── Helpers ────────────────────────────────────────────────────────────────
function generateRoomId() {
  return Math.random().toString(36).substr(2, 9).toUpperCase();
}

function createRoom(socket1, socket2) {
  const roomId = generateRoomId();
  rooms.set(roomId, {
    users: [socket1.id, socket2.id],
    ratings: {},
    startTime: Date.now()
  });
  socketToRoom.set(socket1.id, roomId);
  socketToRoom.set(socket2.id, roomId);

  socket1.join(roomId);
  socket2.join(roomId);

  const u1 = onlineUsers.get(socket1.id);
  const u2 = onlineUsers.get(socket2.id);

  // Notify both peers with partner data
  socket1.emit('match-found', { roomId, role: 'initiator', partner: u2 });
  socket2.emit('match-found', { roomId, role: 'receiver', partner: u1 });

  console.log(`[Room] Created ${roomId} → ${u1?.username} ↔ ${u2?.username}`);
}

function leaveRoom(socket) {
  const roomId = socketToRoom.get(socket.id);
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (room) {
    // Notify partner
    socket.to(roomId).emit('peer-disconnected');
    room.users = room.users.filter(id => id !== socket.id);
    if (room.users.length === 0) {
      rooms.delete(roomId);
    }
  }
  socketToRoom.delete(socket.id);
  socket.leave(roomId);
}

// ─── Socket Events ───────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // ── Register user info ──────────────────────────────────────────────────
  socket.on('register', ({ uid, username, friendCode }) => {
    onlineUsers.set(socket.id, { uid, username, friendCode });
    io.emit('online-count', onlineUsers.size);
    console.log(`[Register] ${username} (${friendCode})`);
  });

  // ── Random matchmaking ──────────────────────────────────────────────────
  socket.on('find-match', () => {
    // Remove from queue if already there
    const idx = waitingQueue.indexOf(socket);
    if (idx !== -1) waitingQueue.splice(idx, 1);

    if (waitingQueue.length > 0) {
      const partner = waitingQueue.shift();
      createRoom(socket, partner);
    } else {
      waitingQueue.push(socket);
      socket.emit('waiting');
      console.log(`[Queue] ${socket.id} is waiting (queue: ${waitingQueue.length})`);
    }
  });

  // Cancel search
  socket.on('cancel-search', () => {
    const idx = waitingQueue.indexOf(socket);
    if (idx !== -1) waitingQueue.splice(idx, 1);
    socket.emit('search-cancelled');
  });

  // ── Friend code connection ──────────────────────────────────────────────
  socket.on('host-friend-code', ({ code }) => {
    friendCodeSessions.set(code, socket.id);
    socket.emit('hosting-code', { code });
    console.log(`[FriendCode] ${socket.id} hosting code: ${code}`);
  });

  socket.on('join-friend-code', ({ code }) => {
    const hostSocketId = friendCodeSessions.get(code);
    if (!hostSocketId) {
      socket.emit('code-not-found');
      return;
    }
    const hostSocket = io.sockets.sockets.get(hostSocketId);
    if (!hostSocket) {
      friendCodeSessions.delete(code);
      socket.emit('code-not-found');
      return;
    }
    friendCodeSessions.delete(code);
    createRoom(socket, hostSocket);
  });

  // ── WebRTC Signaling ────────────────────────────────────────────────────
  socket.on('offer', ({ roomId, offer }) => {
    socket.to(roomId).emit('offer', { offer });
  });

  socket.on('answer', ({ roomId, answer }) => {
    socket.to(roomId).emit('answer', { answer });
  });

  socket.on('ice-candidate', ({ roomId, candidate }) => {
    socket.to(roomId).emit('ice-candidate', { candidate });
  });

  // ── Mogoff / Rating ─────────────────────────────────────────────────────
  socket.on('start-mogoff', ({ roomId }) => {
    socket.to(roomId).emit('mogoff-started');
  });

  socket.on('status-update', ({ roomId, status }) => {
    socket.to(roomId).emit('status-update', { status });
  });

  socket.on('submit-rating', ({ roomId, rating }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.ratings[socket.id] = rating;

    // Notify partner of the rating for live scoring/overtime check
    socket.to(roomId).emit('opponent-rating', { rating });

    // If both rated, reveal results
    if (Object.keys(room.ratings).length === 2) {
      const results = {};
      const uids = {}; 
      
      room.users.forEach(sid => {
        const user = onlineUsers.get(sid);
        results[sid] = room.ratings[sid];
        uids[sid] = user?.uid;
      });

      io.to(roomId).emit('mogoff-results', { results, uids, socketIds: room.users });
    } else {
      socket.emit('rating-submitted');
      socket.to(roomId).emit('partner-rated');
    }
  });

  // ── Chat ────────────────────────────────────────────────────────────────
  socket.on('chat-message', ({ roomId, message }) => {
    const user = onlineUsers.get(socket.id);
    socket.to(roomId).emit('chat-message', {
      from: user?.username || 'Anonymous',
      message,
      timestamp: Date.now()
    });
  });

  // ── Skip / Report ───────────────────────────────────────────────────────
  socket.on('skip', ({ roomId }) => {
    leaveRoom(socket);
    // Re-queue for random
    socket.emit('skipped');
  });

  socket.on('report', ({ roomId, reason }) => {
    console.log(`[Report] Room ${roomId} reported for: ${reason}`);
    socket.emit('report-received');
  });

  // ── Disconnect ──────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[Socket] Disconnected: ${socket.id}`);
    // Remove from queue
    const idx = waitingQueue.indexOf(socket);
    if (idx !== -1) waitingQueue.splice(idx, 1);
    // Remove from friend code hosting
    for (const [code, sid] of friendCodeSessions) {
      if (sid === socket.id) friendCodeSessions.delete(code);
    }
    // Leave any active room
    leaveRoom(socket);
    // Remove from online users
    onlineUsers.delete(socket.id);
    io.emit('online-count', onlineUsers.size);
  });
});

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    online: onlineUsers.size,
    rooms: rooms.size,
    queue: waitingQueue.length
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🚀 Moggable server running on port ${PORT}`);
});

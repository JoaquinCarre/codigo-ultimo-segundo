const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { v4: uuid } = require('uuid');
const path = require('path');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ─── STATIC FILES ────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── ROOMS STATE ─────────────────────────────────────────────────────────────
// rooms[roomId] = {
//   id, code, players: [{id, name, ws, connected}],
//   hostId, gameState: null | G,
//   createdAt
// }
const rooms = new Map();

function cleanupOldRooms() {
  const now = Date.now();
  for (const [id, room] of rooms) {
    // Remove rooms older than 2 hours with no active connections
    const allDisconnected = room.players.every(p => !p.connected);
    if (allDisconnected && now - room.createdAt > 2 * 60 * 60 * 1000) {
      rooms.delete(id);
    }
  }
}
setInterval(cleanupOldRooms, 10 * 60 * 1000);

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function getRoomByCode(code) {
  for (const room of rooms.values()) {
    if (room.code === code.toUpperCase()) return room;
  }
  return null;
}

function broadcast(room, msg, excludeId = null) {
  const data = JSON.stringify(msg);
  for (const player of room.players) {
    if (player.id === excludeId) continue;
    if (player.ws && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(data);
    }
  }
}

function broadcastAll(room, msg) {
  broadcast(room, msg, null);
}

function roomInfo(room) {
  return {
    id: room.id,
    code: room.code,
    hostId: room.hostId,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      isHost: p.id === room.hostId,
    })),
    hasGame: !!room.gameState,
  };
}

// ─── REST ENDPOINTS ───────────────────────────────────────────────────────────

// Create room
app.post('/api/rooms', (req, res) => {
  const { playerName } = req.body;
  if (!playerName || playerName.trim().length === 0) {
    return res.status(400).json({ error: 'Nombre requerido.' });
  }

  const roomId = uuid();
  const playerId = uuid();
  let code;
  do { code = generateCode(); } while (getRoomByCode(code));

  const room = {
    id: roomId,
    code,
    hostId: playerId,
    players: [{
      id: playerId,
      name: playerName.trim().substring(0, 20),
      ws: null,
      connected: false,
    }],
    gameState: null,
    createdAt: Date.now(),
  };
  rooms.set(roomId, room);

  res.json({ roomId, playerId, code, room: roomInfo(room) });
});

// Join room
app.post('/api/rooms/:code/join', (req, res) => {
  const { playerName } = req.body;
  const room = getRoomByCode(req.params.code);

  if (!room) return res.status(404).json({ error: 'Sala no encontrada.' });
  if (!playerName || playerName.trim().length === 0) return res.status(400).json({ error: 'Nombre requerido.' });
  if (room.players.length >= 6) return res.status(400).json({ error: 'Sala llena (máx 6 jugadores).' });
  if (room.gameState) return res.status(400).json({ error: 'La partida ya comenzó.' });

  const playerId = uuid();
  room.players.push({
    id: playerId,
    name: playerName.trim().substring(0, 20),
    ws: null,
    connected: false,
  });

  res.json({ roomId: room.id, playerId, code: room.code, room: roomInfo(room) });
});

// Get room info
app.get('/api/rooms/:code', (req, res) => {
  const room = getRoomByCode(req.params.code);
  if (!room) return res.status(404).json({ error: 'Sala no encontrada.' });
  res.json({ room: roomInfo(room) });
});

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let playerId = null;
  let roomId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { type, data } = msg;

    // ── CONNECT: player identifies themselves after WS opens
    if (type === 'connect') {
      const room = rooms.get(data.roomId);
      if (!room) { ws.send(JSON.stringify({ type: 'error', data: { message: 'Sala no encontrada.' } })); return; }

      const player = room.players.find(p => p.id === data.playerId);
      if (!player) { ws.send(JSON.stringify({ type: 'error', data: { message: 'Jugador no encontrado.' } })); return; }

      // Reassign ws (reconnection support)
      player.ws = ws;
      player.connected = true;
      playerId = player.id;
      roomId = room.id;

      // Send current state to this player
      ws.send(JSON.stringify({
        type: 'connected',
        data: {
          playerId,
          room: roomInfo(room),
          gameState: room.gameState,
        },
      }));

      // Notify others
      broadcast(room, {
        type: 'player_connected',
        data: { playerId: player.id, name: player.name, room: roomInfo(room) },
      }, playerId);

      return;
    }

    // All other messages require an established connection
    if (!playerId || !roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    // ── CHAT / HINT: player sends a verbal hint
    if (type === 'hint') {
      const player = room.players.find(p => p.id === playerId);
      broadcastAll(room, {
        type: 'hint',
        data: { playerId, playerName: player.name, text: data.text },
      });
      return;
    }

    // ── GAME_ACTION: a player performs an action and sends the updated game state
    if (type === 'game_action') {
      // The sending client is the authority on the new game state
      // (simple trust model — fine for a cooperative game with friends)
      room.gameState = data.gameState;

      // Broadcast updated state to everyone including sender (for sync)
      broadcastAll(room, {
        type: 'game_state',
        data: {
          gameState: room.gameState,
          actionBy: playerId,
          action: data.action, // human-readable description for log
        },
      });
      return;
    }

    // ── START_GAME: host starts the game with initial state
    if (type === 'start_game') {
      if (playerId !== room.hostId) {
        ws.send(JSON.stringify({ type: 'error', data: { message: 'Solo el host puede iniciar.' } }));
        return;
      }
      if (room.players.length < 2) {
        ws.send(JSON.stringify({ type: 'error', data: { message: 'Se necesitan al menos 2 jugadores.' } }));
        return;
      }

      room.gameState = data.gameState;

      broadcastAll(room, {
        type: 'game_started',
        data: { gameState: room.gameState, room: roomInfo(room) },
      });
      return;
    }

    // ── END_GAME: notify all that game ended
    if (type === 'end_game') {
      room.gameState = null;
      broadcastAll(room, {
        type: 'game_ended',
        data: { result: data.result, message: data.message },
      });
      return;
    }

    // ── PING / PONG
    if (type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });

  ws.on('close', () => {
    if (!playerId || !roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (player) {
      player.connected = false;
      player.ws = null;
    }
    broadcast(room, {
      type: 'player_disconnected',
      data: { playerId, name: player?.name, room: roomInfo(room) },
    });
  });

  ws.on('error', (err) => {
    console.error('WS error:', err.message);
  });
});

// ─── START ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});

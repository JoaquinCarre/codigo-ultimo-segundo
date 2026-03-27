const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { v4: uuid } = require('uuid');
const path = require('path');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── STATE ─────────────────────────────────────────────────────────────────
// Room: { id, code, hostId, players:[{id,name,ws,connected,isSpectator,isBot}], gameState, createdAt }
const rooms = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    const allOff = room.players.every(p => !p.connected && !p.isBot);
    if (allOff && now - room.createdAt > 7200000) rooms.delete(id);
  }
}, 600000);

// ─── HELPERS ───────────────────────────────────────────────────────────────
function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
function byCode(code) {
  for (const r of rooms.values()) if (r.code === code.toUpperCase()) return r;
  return null;
}
function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function sendAll(room, msg, excludeId = null) {
  const d = JSON.stringify(msg);
  for (const p of room.players) {
    if (p.id === excludeId || p.isBot) continue;
    if (p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(d);
  }
}
function roomInfo(room) {
  return {
    id: room.id, code: room.code, hostId: room.hostId,
    players: room.players.map(p => ({
      id: p.id, name: p.name, connected: p.connected,
      isHost: p.id === room.hostId,
      isSpectator: !!p.isSpectator,
      isBot: !!p.isBot,
    })),
    hasGame: !!room.gameState,
  };
}
function activePlayers(room) { return room.players.filter(p => !p.isSpectator); }

// ─── REST ──────────────────────────────────────────────────────────────────

// Create room
app.post('/api/rooms', (req, res) => {
  const name = (req.body.playerName || '').trim().substring(0, 20);
  if (!name) return res.status(400).json({ error: 'Nombre requerido.' });
  const roomId = uuid(), playerId = uuid();
  let code; do { code = genCode(); } while (byCode(code));
  const room = {
    id: roomId, code, hostId: playerId,
    players: [{ id: playerId, name, ws: null, connected: false, isSpectator: false, isBot: false }],
    gameState: null, createdAt: Date.now(),
  };
  rooms.set(roomId, room);
  res.json({ roomId, playerId, code, isHost: true, isSpectator: false, room: roomInfo(room) });
});

// Join room
app.post('/api/rooms/:code/join', (req, res) => {
  const name = (req.body.playerName || '').trim().substring(0, 20);
  const room = byCode(req.params.code);
  if (!room) return res.status(404).json({ error: 'Sala no encontrada.' });
  if (!name) return res.status(400).json({ error: 'Nombre requerido.' });
  const active = activePlayers(room);
  const isSpectator = active.length >= 6 || !!room.gameState;
  const playerId = uuid();
  room.players.push({ id: playerId, name, ws: null, connected: false, isSpectator, isBot: false });
  res.json({ roomId: room.id, playerId, code: room.code,
    isHost: false, isSpectator,
    room: roomInfo(room) });
});

// Rejoin (called on page refresh with saved localStorage data)
app.post('/api/rooms/:roomId/rejoin', (req, res) => {
  const { playerId } = req.body;
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Sala expirada.' });
  const player = room.players.find(p => p.id === playerId);
  if (!player) return res.status(404).json({ error: 'Sesion no encontrada en esta sala.' });
  res.json({
    roomId: room.id, playerId, code: room.code,
    isHost: room.hostId === playerId,
    isSpectator: !!player.isSpectator,
    room: roomInfo(room),
    gameState: room.gameState,
  });
});

// Toggle spectator <-> active player (before game starts)
app.post('/api/rooms/:roomId/toggle-spectator', (req, res) => {
  const { playerId } = req.body;
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Sala no encontrada.' });
  if (room.gameState) return res.status(400).json({ error: 'La partida ya inicio.' });
  const player = room.players.find(p => p.id === playerId);
  if (!player) return res.status(404).json({ error: 'Jugador no encontrado.' });
  if (player.id === room.hostId) return res.status(400).json({ error: 'El host no puede ser espectador.' });
  if (player.isSpectator) {
    if (activePlayers(room).length >= 6) return res.status(400).json({ error: 'Sala llena (max 6 activos).' });
    player.isSpectator = false;
  } else {
    player.isSpectator = true;
  }
  sendAll(room, { type: 'room_update', data: { room: roomInfo(room) } });
  res.json({ room: roomInfo(room) });
});

// Add bot (host only, before game starts)
app.post('/api/rooms/:roomId/add-bot', (req, res) => {
  const { playerId } = req.body;
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Sala no encontrada.' });
  if (room.hostId !== playerId) return res.status(403).json({ error: 'Solo el host puede agregar bots.' });
  if (room.gameState) return res.status(400).json({ error: 'La partida ya inicio.' });
  if (activePlayers(room).length >= 6) return res.status(400).json({ error: 'Sala llena.' });
  const botId = uuid();
  const botNum = room.players.filter(p => p.isBot).length + 1;
  room.players.push({ id: botId, name: 'BOT-'+botNum, ws: null, connected: true, isSpectator: false, isBot: true });
  sendAll(room, { type: 'room_update', data: { room: roomInfo(room) } });
  res.json({ botId, room: roomInfo(room) });
});

// Remove bot (host only)
app.post('/api/rooms/:roomId/remove-bot', (req, res) => {
  const { playerId, botId } = req.body;
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Sala no encontrada.' });
  if (room.hostId !== playerId) return res.status(403).json({ error: 'Solo el host puede quitar bots.' });
  if (room.gameState) return res.status(400).json({ error: 'La partida ya inicio.' });
  room.players = room.players.filter(p => p.id !== botId);
  sendAll(room, { type: 'room_update', data: { room: roomInfo(room) } });
  res.json({ room: roomInfo(room) });
});

// Get room
app.get('/api/rooms/:code', (req, res) => {
  const room = byCode(req.params.code);
  if (!room) return res.status(404).json({ error: 'Sala no encontrada.' });
  res.json({ room: roomInfo(room) });
});

// ─── WEBSOCKET ─────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let playerId = null, roomId = null;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const { type, data } = msg;

    if (type === 'connect') {
      const room = rooms.get(data.roomId);
      if (!room) { send(ws, { type: 'error', data: { message: 'Sala no encontrada.' } }); return; }
      const player = room.players.find(p => p.id === data.playerId);
      if (!player) { send(ws, { type: 'error', data: { message: 'Sesion no encontrada.' } }); return; }
      player.ws = ws; player.connected = true;
      playerId = player.id; roomId = room.id;
      send(ws, { type: 'connected', data: {
        playerId, isSpectator: !!player.isSpectator,
        isHost: room.hostId === playerId,
        room: roomInfo(room), gameState: room.gameState,
      }});
      sendAll(room, { type: 'player_connected', data: { playerId: player.id, name: player.name, room: roomInfo(room) } }, playerId);
      return;
    }

    if (!playerId || !roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    if (type === 'hint') {
      const player = room.players.find(p => p.id === playerId);
      sendAll(room, { type: 'hint', data: { playerId, playerName: player.name, text: data.text } });
      return;
    }
    if (type === 'game_action') {
      room.gameState = data.gameState;
      sendAll(room, { type: 'game_state', data: { gameState: room.gameState, actionBy: playerId, action: data.action } });
      return;
    }
    if (type === 'start_game') {
      if (playerId !== room.hostId) { send(ws, { type: 'error', data: { message: 'Solo el host puede iniciar.' } }); return; }
      const ap = activePlayers(room);
      if (ap.length < 2) { send(ws, { type: 'error', data: { message: 'Se necesitan al menos 2 jugadores activos.' } }); return; }
      room.gameState = data.gameState;
      sendAll(room, { type: 'game_started', data: { gameState: room.gameState, room: roomInfo(room) } });
      return;
    }
    if (type === 'end_game') {
      room.gameState = null;
      sendAll(room, { type: 'game_ended', data: data });
      return;
    }
    if (type === 'ping') send(ws, { type: 'pong' });
  });

  ws.on('close', () => {
    if (!playerId || !roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (player) { player.connected = false; player.ws = null; }
    sendAll(room, { type: 'player_disconnected', data: { playerId, name: player?.name, room: roomInfo(room) } });
  });

  ws.on('error', err => console.error('WS:', err.message));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Puerto ' + PORT));

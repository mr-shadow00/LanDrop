// server/index.js
//
// LanDrop server. Two jobs, both intentionally dumb:
//  1. Serve the static frontend.
//  2. Relay WebSocket signaling messages between browsers so they can set up
//     a direct WebRTC connection with each other. The server never sees file
//     contents — files travel peer-to-peer once the connection is up.

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const { randomName, deviceInfoFromUA } = require('./names');

const PORT = process.env.PORT || 3000;

const app = express();
app.set('trust proxy', 1); // play nicely behind a reverse proxy on the NAS

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.get('/api/health', (req, res) => res.json({ ok: true, peers: peers.size }));

app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// id -> { ws, name, type, os, browser, alive }
const peers = new Map();

function peerPublicInfo(id) {
  const p = peers.get(id);
  if (!p) return null;
  return { id, name: p.name, type: p.type, os: p.os, browser: p.browser };
}

function broadcastPeerList() {
  const all = [...peers.keys()].map(peerPublicInfo);
  for (const [id, p] of peers) {
    send(p.ws, { type: 'peers', peers: all.filter((x) => x.id !== id) });
  }
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error('send failed', err);
    }
  }
}

wss.on('connection', (ws, req) => {
  const id = crypto.randomUUID();
  const ua = req.headers['user-agent'] || '';
  const info = deviceInfoFromUA(ua);
  const name = randomName([...peers.values()].map((p) => p.name));

  peers.set(id, { ws, name, ...info, alive: true });

  send(ws, { type: 'welcome', self: peerPublicInfo(id) });
  broadcastPeerList();

  ws.on('pong', () => {
    const p = peers.get(id);
    if (p) p.alive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'signal' && msg.target) {
      const target = peers.get(msg.target);
      if (target) {
        send(target.ws, { type: 'signal', sender: id, data: msg.data });
      }
      return;
    }

    if (msg.type === 'rename' && typeof msg.name === 'string') {
      const clean = msg.name.trim().slice(0, 30);
      if (clean) {
        const p = peers.get(id);
        if (p) {
          p.name = clean;
          broadcastPeerList();
        }
      }
    }
  });

  ws.on('close', () => {
    peers.delete(id);
    broadcastPeerList();
  });

  ws.on('error', () => {
    peers.delete(id);
    broadcastPeerList();
  });
});

// Heartbeat: drop dead sockets (e.g. laptop lid closed, wifi dropped)
// so the peer list stays accurate instead of showing ghosts.
const HEARTBEAT_MS = 20000;
setInterval(() => {
  let changed = false;
  for (const [id, p] of peers) {
    if (p.alive === false) {
      p.ws.terminate();
      peers.delete(id);
      changed = true;
      continue;
    }
    p.alive = false;
    try {
      p.ws.ping();
    } catch {
      peers.delete(id);
      changed = true;
    }
  }
  if (changed) broadcastPeerList();
}, HEARTBEAT_MS);

server.listen(PORT, () => {
  console.log(`LanDrop listening on port ${PORT}`);
});

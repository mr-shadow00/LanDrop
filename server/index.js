// server/index.js
//
// LanDrop server.
//  1. Serves the static frontend.
//  2. WebSocket: peer discovery + transfer negotiation (offer / accept / ready).
//  3. HTTP relay: sender PUTs the file to /api/upload/:id, receiver GETs it from
//     /api/download/:id. Plain HTTP only (no WebRTC), so it works over NetBird,
//     any VPN, or plain LAN as long as both devices can reach this server.
//     Files are stored briefly in a temp dir and deleted after download.

const path = require('path');
const fs = require('fs');
const os = require('os');
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

// ---------------------------------------------------------------------
// Transfer relay
// ---------------------------------------------------------------------
const TMP_DIR = path.join(process.env.LANDROP_TMP || os.tmpdir(), 'landrop-transfers');
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES) || 0; // 0 = unlimited
const TRANSFER_TTL_MS = 30 * 60 * 1000;
fs.rmSync(TMP_DIR, { recursive: true, force: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

// id -> { from, to, name, size, mime, state, file, created }
// state: offered -> accepted -> uploading -> ready -> done
const transfers = new Map();

function dropTransfer(id) {
  const t = transfers.get(id);
  if (!t) return;
  transfers.delete(id);
  if (t.file) fs.rm(t.file, { force: true }, () => {});
}

const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id);

app.put('/api/upload/:id', (req, res) => {
  const t = transfers.get(req.params.id);
  if (!validId(req.params.id) || !t || t.from !== req.query.peer || t.state !== 'accepted') {
    return res.status(403).json({ error: 'not allowed' });
  }
  t.state = 'uploading';
  t.file = path.join(TMP_DIR, crypto.randomUUID());
  const out = fs.createWriteStream(t.file);
  let bytes = 0;
  let failed = false;

  const fail = (code, msg) => {
    if (failed) return;
    failed = true;
    out.destroy();
    const to = peers.get(t.to);
    if (to) send(to.ws, { type: 'transfer-failed', id: req.params.id });
    const from = peers.get(t.from);
    if (from) send(from.ws, { type: 'transfer-failed', id: req.params.id });
    dropTransfer(req.params.id);
    if (!res.headersSent) res.status(code).json({ error: msg });
  };

  req.on('data', (chunk) => {
    bytes += chunk.length;
    if ((MAX_FILE_BYTES && bytes > MAX_FILE_BYTES) || bytes > t.size + 1024) {
      req.destroy();
      fail(413, 'too large');
    }
  });
  req.on('aborted', () => fail(499, 'aborted'));
  req.on('error', () => fail(500, 'upload error'));
  out.on('error', () => fail(500, 'disk error'));
  req.pipe(out);
  out.on('finish', () => {
    if (failed) return;
    t.state = 'ready';
    const to = peers.get(t.to);
    if (to) send(to.ws, { type: 'transfer-ready', id: req.params.id });
    res.json({ ok: true });
  });
});

app.get('/api/download/:id', (req, res) => {
  const t = transfers.get(req.params.id);
  if (!validId(req.params.id) || !t || t.to !== req.query.peer || t.state !== 'ready') {
    return res.status(404).send('Not found or already downloaded');
  }
  t.state = 'done';
  const stat = fs.statSync(t.file);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', stat.size);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(t.name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}`
  );
  const rs = fs.createReadStream(t.file);
  rs.pipe(res);
  const cleanup = () => dropTransfer(req.params.id);
  res.on('close', cleanup);
  rs.on('error', () => { res.destroy(); cleanup(); });
});

// Sweep abandoned transfers
setInterval(() => {
  const now = Date.now();
  for (const [id, t] of transfers) {
    if (now - t.created > TRANSFER_TTL_MS) dropTransfer(id);
  }
}, 60 * 1000);

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

    // --- transfer negotiation ---
    if (msg.type === 'transfer-offer' && msg.target && validId(msg.id)) {
      const target = peers.get(msg.target);
      if (!target || transfers.has(msg.id)) return send(ws, { type: 'transfer-failed', id: msg.id });
      const size = Number(msg.size) || 0;
      if (MAX_FILE_BYTES && size > MAX_FILE_BYTES) return send(ws, { type: 'transfer-failed', id: msg.id });
      transfers.set(msg.id, {
        from: id, to: msg.target, name: String(msg.name || 'file').slice(0, 255),
        size, mime: msg.mime || '', state: 'offered', created: Date.now(),
      });
      send(target.ws, {
        type: 'transfer-offer', id: msg.id, sender: id,
        name: String(msg.name || 'file').slice(0, 255), size,
      });
      return;
    }

    if (msg.type === 'transfer-response' && validId(msg.id)) {
      const t = transfers.get(msg.id);
      if (!t || t.to !== id || t.state !== 'offered') return;
      const sender = peers.get(t.from);
      if (msg.accept) {
        t.state = 'accepted';
      } else {
        dropTransfer(msg.id);
      }
      if (sender) send(sender.ws, { type: 'transfer-response', id: msg.id, accept: !!msg.accept });
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

  const cleanupPeer = () => {
    peers.delete(id);
    for (const [tid, t] of transfers) {
      if (t.from === id || t.to === id) {
        const otherId = t.from === id ? t.to : t.from;
        const other = peers.get(otherId);
        if (other) send(other.ws, { type: 'transfer-failed', id: tid });
        dropTransfer(tid);
      }
    }
    broadcastPeerList();
  };
  ws.on('close', cleanupPeer);
  ws.on('error', cleanupPeer);
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

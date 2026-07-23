// public/js/app.js
//
// LanDrop client. Structure:
//   1. Signaling socket   - talk to our server, discover peers
//   2. Peer field UI      - draw peers in orbit around "You", handle clicks/drag&drop
//   3. Transfer engine    - one RTCPeerConnection + one reliable DataChannel per peer,
//                           chunked sends with backpressure, receiver reassembly
//   4. Toasts             - progress / done / error notices

(() => {
  'use strict';

  const CHUNK_SIZE = 64 * 1024;           // 64KB per chunk — safe across browsers
  const BUFFERED_AMOUNT_HIGH = 8 * 1024 * 1024;  // pause sending above 8MB queued
  const BUFFERED_AMOUNT_LOW = 2 * 1024 * 1024;   // resume once queue drains below 2MB
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

  const els = {
    selfName: document.getElementById('self-name'),
    peerField: document.getElementById('peer-field'),
    emptyState: document.getElementById('empty-state'),
    toasts: document.getElementById('toasts'),
    toastTpl: document.getElementById('tpl-toast'),
    requestTpl: document.getElementById('tpl-request'),
    fileInput: document.getElementById('file-input'),
    dropOverlay: document.getElementById('drop-overlay'),
  };

  const NAME_STORAGE_KEY = 'landrop:device-name';
  const REQUEST_TIMEOUT_MS = 60000; // auto-decline if the receiver never responds

  const state = {
    self: null,          // { id, name, type }
    peers: new Map(),    // id -> { id, name, type, os, browser, el, x, y }
    connections: new Map(), // id -> ConnPeer
    pendingSendTarget: null, // peer id awaiting file picker result
  };

  let ws = null;
  let wsReconnectDelay = 1000;

  // ---------------------------------------------------------------------
  // Signaling
  // ---------------------------------------------------------------------

  function connectSocket() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.addEventListener('open', () => {
      wsReconnectDelay = 1000;
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handleSignalMessage(msg);
    });

    ws.addEventListener('close', () => {
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      try { ws.close(); } catch {}
    });
  }

  function scheduleReconnect() {
    setTimeout(connectSocket, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 1.6, 15000);
  }

  function sendSignal(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function handleSignalMessage(msg) {
    if (msg.type === 'welcome') {
      state.self = msg.self;
      els.selfName.textContent = state.self.name;

      // The server hands out a fresh random name on every connect. If the
      // user previously chose a name on this device, restore it.
      const savedName = localStorage.getItem(NAME_STORAGE_KEY);
      if (savedName && savedName !== state.self.name) {
        state.self.name = savedName;
        els.selfName.textContent = savedName;
        sendSignal({ type: 'rename', name: savedName });
      }
      return;
    }

    if (msg.type === 'peers') {
      renderPeerList(msg.peers);
      return;
    }

    if (msg.type === 'signal') {
      handleIncomingSignal(msg.sender, msg.data);
      return;
    }
  }

  // ---------------------------------------------------------------------
  // Peer field UI
  // ---------------------------------------------------------------------

  function iconForType(type) {
    if (type === 'mobile') {
      return '<svg viewBox="0 0 24 24" fill="none"><rect x="7" y="2" width="10" height="20" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M11 18h2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    }
    if (type === 'tablet') {
      return '<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="3" width="16" height="18" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M11 18h2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="12" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M8 20h8M12 16v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  }

  function renderPeerList(list) {
    const incomingIds = new Set(list.map((p) => p.id));

    // Remove peers who left
    for (const id of [...state.peers.keys()]) {
      if (!incomingIds.has(id)) {
        const p = state.peers.get(id);
        if (p.el) p.el.remove();
        state.peers.delete(id);
        closeConnection(id);
      }
    }

    // Add/update
    for (const p of list) {
      if (!state.peers.has(p.id)) {
        const el = createPeerEl(p);
        els.peerField.appendChild(el);
        state.peers.set(p.id, { ...p, el });
      } else {
        const existing = state.peers.get(p.id);
        existing.name = p.name;
        const label = existing.el.querySelector('.peer-label');
        if (label) label.textContent = p.name;
      }
    }

    layoutPeers();
    els.emptyState.classList.toggle('hidden', state.peers.size > 0);
  }

  function createPeerEl(p) {
    const el = document.createElement('div');
    el.className = 'peer-node';
    el.dataset.peerId = p.id;
    el.innerHTML = `
      <div class="peer-icon">${iconForType(p.type)}</div>
      <div class="peer-label">${escapeHtml(p.name)}</div>
    `;
    el.addEventListener('click', () => promptFilePicker(p.id));

    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      hideDropOverlay();
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) sendFilesTo(p.id, files);
    });

    return el;
  }

  function layoutPeers() {
    const ids = [...state.peers.keys()];
    const n = ids.length;
    if (n === 0) return;

    const field = els.peerField.getBoundingClientRect();
    const radius = Math.min(field.width, field.height) / 2 - 60;

    ids.forEach((id, i) => {
      const angle = (2 * Math.PI * i) / n - Math.PI / 2;
      const x = Math.round(Math.cos(angle) * radius);
      const y = Math.round(Math.sin(angle) * radius);
      const p = state.peers.get(id);
      p.x = x;
      p.y = y;
      p.el.style.setProperty('--tx', `${x}px`);
      p.el.style.setProperty('--ty', `${y}px`);
    });
  }

  window.addEventListener('resize', layoutPeers);

  // Traveling-pulse line from You to a peer while a send is in progress.
  let linkSvg = null;
  function ensureLinkSvg() {
    if (linkSvg) return linkSvg;
    linkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    linkSvg.setAttribute('class', 'link-layer');
    linkSvg.setAttribute('width', '100%');
    linkSvg.setAttribute('height', '100%');
    els.peerField.insertBefore(linkSvg, els.peerField.firstChild);
    return linkSvg;
  }

  function setLinkActive(peerId, active) {
    const svg = ensureLinkSvg();
    const existing = svg.querySelector(`[data-link="${peerId}"]`);
    if (!active) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    const p = state.peers.get(peerId);
    if (!p) return;
    const rect = els.peerField.getBoundingClientRect();
    const cx = rect.width / 2, cy = rect.height / 2;
    const tx = cx + p.x, ty = cy + p.y;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('data-link', peerId);

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', cx); line.setAttribute('y1', cy);
    line.setAttribute('x2', tx); line.setAttribute('y2', ty);
    line.setAttribute('class', 'link-line');
    g.appendChild(line);

    const pulse = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    pulse.setAttribute('r', 4);
    pulse.setAttribute('class', 'link-pulse');
    const anim = document.createElementNS('http://www.w3.org/2000/svg', 'animateMotion');
    anim.setAttribute('dur', '0.9s');
    anim.setAttribute('repeatCount', 'indefinite');
    anim.setAttribute('path', `M${cx},${cy} L${tx},${ty}`);
    pulse.appendChild(anim);
    g.appendChild(pulse);

    svg.appendChild(g);
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let val = bytes, i = 0;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    return `${val >= 10 || i === 0 ? Math.round(val) : val.toFixed(1)} ${units[i]}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // Self rename
  els.selfName.addEventListener('click', () => {
    const next = prompt('Name this device (visible to others on the network):', state.self?.name || '');
    if (next && next.trim()) {
      const clean = next.trim();
      sendSignal({ type: 'rename', name: clean });
      els.selfName.textContent = clean;
      if (state.self) state.self.name = clean;
      try { localStorage.setItem(NAME_STORAGE_KEY, clean); } catch {}
    }
  });

  // Whole-window drag & drop -> if exactly one peer, drop overlay just shows hint;
  // real send happens by dropping on a specific peer node.
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    dragDepth++;
    showDropOverlay();
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hideDropOverlay();
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    hideDropOverlay();
  });

  function showDropOverlay() { els.dropOverlay.classList.remove('hidden'); }
  function hideDropOverlay() { els.dropOverlay.classList.add('hidden'); }

  // File picker flow (click a peer)
  function promptFilePicker(peerId) {
    state.pendingSendTarget = peerId;
    els.fileInput.value = '';
    els.fileInput.click();
  }
  els.fileInput.addEventListener('change', () => {
    const files = [...els.fileInput.files];
    const target = state.pendingSendTarget;
    state.pendingSendTarget = null;
    if (target && files.length) sendFilesTo(target, files);
  });

  // ---------------------------------------------------------------------
  // Toasts
  // ---------------------------------------------------------------------

  function createToast({ title, sub, icon }) {
    const node = els.toastTpl.content.firstElementChild.cloneNode(true);
    node.querySelector('.toast-title').textContent = title;
    node.querySelector('.toast-sub').textContent = sub || '';
    node.querySelector('.toast-icon').innerHTML = icon || '';
    els.toasts.appendChild(node);
    return {
      el: node,
      setProgress(pct) {
        node.querySelector('.toast-progress-bar').style.width = `${Math.min(100, pct)}%`;
      },
      setSub(text) { node.querySelector('.toast-sub').textContent = text; },
      done() { node.classList.add('done'); },
      error(text) {
        node.classList.add('error');
        if (text) node.querySelector('.toast-sub').textContent = text;
      },
      dismissAfter(ms) {
        setTimeout(() => node.remove(), ms);
      },
    };
  }

  const ICON_SEND = '<svg viewBox="0 0 24 24" fill="none"><path d="M12 19V5m0 0l-6 6m6-6l6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_RECEIVE = '<svg viewBox="0 0 24 24" fill="none"><path d="M12 5v14m0 0l-6-6m6 6l6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // Incoming-file prompt: shown before anything is written to disk. Resolves
  // true (accept) or false (decline/timeout).
  function createRequestToast({ title, sub, icon }) {
    const node = els.requestTpl.content.firstElementChild.cloneNode(true);
    node.querySelector('.toast-title').textContent = title;
    node.querySelector('.toast-sub').textContent = sub || '';
    node.querySelector('.toast-icon').innerHTML = icon || '';
    els.toasts.appendChild(node);

    const acceptBtn = node.querySelector('.request-btn.accept');
    const declineBtn = node.querySelector('.request-btn.decline');

    return new Promise((resolve) => {
      let settled = false;
      const finish = (accepted) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        acceptBtn.disabled = true;
        declineBtn.disabled = true;
        node.remove();
        resolve(accepted);
      };
      acceptBtn.addEventListener('click', () => finish(true));
      declineBtn.addEventListener('click', () => finish(false));
      const timer = setTimeout(() => finish(false), REQUEST_TIMEOUT_MS);
    });
  }

  // ---------------------------------------------------------------------
  // Transfer engine
  // ---------------------------------------------------------------------

  class ConnPeer {
    constructor(peerId) {
      this.peerId = peerId;
      this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      this.dc = null;
      this.sendQueue = [];       // queued { files } batches waiting for dc to open
      this.receiving = null;     // { id, name, size, mime, chunks, received }
      this.sendActive = false;
      this.pendingAccepts = new Map(); // fileId -> { resolve, reject }

      this.pc.onicecandidate = (e) => {
        if (e.candidate) {
          sendSignal({ type: 'signal', target: peerId, data: { kind: 'candidate', candidate: e.candidate } });
        }
      };

      this.pc.oniceconnectionstatechange = () => {
        const st = this.pc.iceConnectionState;
        if (st === 'failed') {
          try { this.pc.restartIce(); } catch {}
        }
        if (st === 'closed' || st === 'disconnected') {
          // leave cleanup to explicit close paths / peer-list updates
        }
      };

      this.pc.ondatachannel = (e) => {
        this.attachChannel(e.channel);
      };
    }

    attachChannel(channel) {
      this.dc = channel;
      channel.binaryType = 'arraybuffer';
      channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW;

      channel.onopen = () => {
        this.flushQueue();
      };

      channel.onmessage = (e) => this.handleMessage(e.data);

      channel.onclose = () => {};
      channel.onerror = () => {};
    }

    ensureChannel() {
      if (!this.dc) {
        const channel = this.pc.createDataChannel('landrop', { ordered: true });
        this.attachChannel(channel);
      }
      return this.dc;
    }

    handleMessage(data) {
      if (typeof data === 'string') {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }

        if (msg.type === 'file-start') {
          this.handleIncomingFileRequest(msg);
        } else if (msg.type === 'file-end') {
          this.finishReceivingFile();
        } else if (msg.type === 'file-accept') {
          const pending = this.pendingAccepts.get(msg.id);
          if (pending) {
            this.pendingAccepts.delete(msg.id);
            pending.resolve();
          }
        } else if (msg.type === 'file-decline') {
          const pending = this.pendingAccepts.get(msg.id);
          if (pending) {
            this.pendingAccepts.delete(msg.id);
            pending.reject(new Error('declined'));
          }
        }
        return;
      }

      // Binary chunk
      if (this.receiving) {
        this.receiving.chunks.push(data);
        this.receiving.received += data.byteLength;
        if (this.receivingToast) {
          const pct = Math.floor((this.receiving.received / this.receiving.size) * 100);
          this.receivingToast.setProgress(pct);
          const peerName = state.peers.get(this.peerId)?.name || 'a device';
          this.receivingToast.setSub(`from ${peerName} — ${pct}%`);
        }
      }
    }

    async handleIncomingFileRequest(msg) {
      const peerName = state.peers.get(this.peerId)?.name || 'a device';
      const dc = this.dc;

      const accepted = await createRequestToast({
        title: `${peerName} wants to send a file`,
        sub: `${msg.name} — ${formatBytes(msg.size)}`,
        icon: ICON_RECEIVE,
      });

      // Peer may have disconnected while the prompt was up.
      if (!dc || dc.readyState !== 'open') return;

      if (!accepted) {
        try { dc.send(JSON.stringify({ type: 'file-decline', id: msg.id })); } catch {}
        return;
      }

      this.receiving = {
        id: msg.id,
        name: msg.name,
        size: msg.size,
        mime: msg.mime || 'application/octet-stream',
        chunks: [],
        received: 0,
      };
      try { dc.send(JSON.stringify({ type: 'file-accept', id: msg.id })); } catch {}

      this.receivingToast = createToast({
        title: `Receiving ${msg.name}`,
        sub: `from ${peerName} — 0%`,
        icon: ICON_RECEIVE,
      });
    }

    finishReceivingFile() {
      const r = this.receiving;
      this.receiving = null;
      if (!r) return;
      const blob = new Blob(r.chunks, { type: r.mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = r.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);

      if (this.receivingToast) {
        this.receivingToast.setProgress(100);
        this.receivingToast.setSub('Saved to your downloads');
        this.receivingToast.done();
        this.receivingToast.dismissAfter(4000);
        this.receivingToast = null;
      }
    }

    async sendFiles(files) {
      this.ensureChannel();
      if (this.dc.readyState !== 'open') {
        this.sendQueue.push(files);
        return;
      }
      await this._sendFilesNow(files);
    }

    flushQueue() {
      const queued = this.sendQueue.splice(0);
      queued.forEach((files) => this._sendFilesNow(files));
    }

    async _sendFilesNow(files) {
      const peerEl = state.peers.get(this.peerId)?.el;
      if (peerEl) peerEl.classList.add('sending');
      setLinkActive(this.peerId, true);

      for (const file of files) {
        const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const toast = createToast({
          title: `Sending ${file.name}`,
          sub: `to ${state.peers.get(this.peerId)?.name || 'device'} — 0%`,
          icon: ICON_SEND,
        });

        try {
          await this.sendOneFile(file, fileId, toast);
          toast.setProgress(100);
          toast.setSub('Delivered');
          toast.done();
          toast.dismissAfter(3000);
        } catch (err) {
          if (err && err.message === 'declined') {
            toast.error(`${state.peers.get(this.peerId)?.name || 'They'} declined the file`);
          } else if (err && err.message === 'no response — request timed out') {
            toast.error('No response — request timed out');
          } else {
            toast.error('Transfer failed — connection dropped');
          }
          toast.dismissAfter(6000);
          break;
        }
      }

      if (peerEl) peerEl.classList.remove('sending');
      setLinkActive(this.peerId, false);
    }

    async sendOneFile(file, fileId, toast) {
      const dc = this.dc;
      if (!dc || dc.readyState !== 'open') throw new Error('channel not open');

      dc.send(JSON.stringify({
        type: 'file-start', id: fileId, name: file.name, size: file.size, mime: file.type,
      }));

      toast.setSub(`to ${state.peers.get(this.peerId)?.name || 'device'} — waiting for accept…`);

      // Wait for the receiver to accept before sending any bytes.
      await new Promise((resolve, reject) => {
        const onClose = () => {
          this.pendingAccepts.delete(fileId);
          reject(new Error('closed'));
        };
        dc.addEventListener('close', onClose, { once: true });

        const timer = setTimeout(() => {
          this.pendingAccepts.delete(fileId);
          dc.removeEventListener('close', onClose);
          reject(new Error('no response — request timed out'));
        }, REQUEST_TIMEOUT_MS + 5000); // a little longer than the receiver's own prompt timeout

        this.pendingAccepts.set(fileId, {
          resolve: () => {
            clearTimeout(timer);
            dc.removeEventListener('close', onClose);
            resolve();
          },
          reject: (err) => {
            clearTimeout(timer);
            dc.removeEventListener('close', onClose);
            reject(err);
          },
        });
      });

      return new Promise((resolve, reject) => {
        let offset = 0;
        const reader = file.stream ? file.stream().getReader() : null;

        const onClose = () => reject(new Error('closed'));
        dc.addEventListener('close', onClose, { once: true });

        const sendNextSlice = () => {
          if (offset >= file.size) {
            try {
              dc.send(JSON.stringify({ type: 'file-end', id: fileId }));
            } catch (err) {
              dc.removeEventListener('close', onClose);
              return reject(err);
            }
            dc.removeEventListener('close', onClose);
            return resolve();
          }

          if (dc.bufferedAmount > BUFFERED_AMOUNT_HIGH) {
            dc.onbufferedamountlow = () => {
              dc.onbufferedamountlow = null;
              sendNextSlice();
            };
            return;
          }

          const slice = file.slice(offset, offset + CHUNK_SIZE);
          slice.arrayBuffer().then((buf) => {
            try {
              dc.send(buf);
            } catch (err) {
              dc.removeEventListener('close', onClose);
              return reject(err);
            }
            offset += buf.byteLength;
            const pct = Math.floor((offset / file.size) * 100);
            toast.setProgress(pct);
            toast.setSub(`to ${state.peers.get(this.peerId)?.name || 'device'} — ${pct}%`);
            // Yield back to the event loop so UI + incoming signals stay responsive.
            setTimeout(sendNextSlice, 0);
          }).catch((err) => {
            dc.removeEventListener('close', onClose);
            reject(err);
          });
        };

        sendNextSlice();
      });
    }

    close() {
      for (const pending of this.pendingAccepts.values()) {
        pending.reject(new Error('closed'));
      }
      this.pendingAccepts.clear();
      try { this.dc && this.dc.close(); } catch {}
      try { this.pc.close(); } catch {}
    }
  }

  function getOrCreateConn(peerId) {
    let conn = state.connections.get(peerId);
    if (!conn) {
      conn = new ConnPeer(peerId);
      state.connections.set(peerId, conn);
    }
    return conn;
  }

  function closeConnection(peerId) {
    const conn = state.connections.get(peerId);
    if (conn) {
      conn.close();
      state.connections.delete(peerId);
    }
  }

  async function sendFilesTo(peerId, files) {
    const conn = getOrCreateConn(peerId);
    const needsOffer = !conn.dc && conn.pc.signalingState === 'stable' && !conn._offering;

    conn.sendFiles(files);

    if (needsOffer) {
      conn._offering = true;
      try {
        conn.ensureChannel();
        const offer = await conn.pc.createOffer();
        await conn.pc.setLocalDescription(offer);
        sendSignal({ type: 'signal', target: peerId, data: { kind: 'offer', sdp: offer } });
      } catch (err) {
        console.error('offer failed', err);
        conn._offering = false;
      }
    }
  }

  async function handleIncomingSignal(senderId, data) {
    if (!state.peers.has(senderId)) return; // stale peer, ignore
    const conn = getOrCreateConn(senderId);

    if (data.kind === 'offer') {
      try {
        await conn.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        const answer = await conn.pc.createAnswer();
        await conn.pc.setLocalDescription(answer);
        sendSignal({ type: 'signal', target: senderId, data: { kind: 'answer', sdp: answer } });
      } catch (err) {
        console.error('answer failed', err);
      }
    } else if (data.kind === 'answer') {
      try {
        await conn.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      } catch (err) {
        console.error('setRemoteDescription(answer) failed', err);
      } finally {
        conn._offering = false;
      }
    } else if (data.kind === 'candidate') {
      try {
        await conn.pc.addIceCandidate(data.candidate);
      } catch (err) {
        // Benign if it arrives after the connection already closed.
      }
    }
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  connectSocket();

  // PWA install support (installability only — no offline caching, see sw.js)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();

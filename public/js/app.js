// public/js/app.js
//
// LanDrop client. Structure:
//   1. Signaling socket   - talk to our server, discover peers
//   2. Peer field UI      - draw peers in orbit around "You", handle clicks/drag&drop
//   3. Transfer engine    - offer/accept over WebSocket, then plain HTTP upload
//                           (sender -> server) and download (server -> receiver).
//                           No WebRTC, so it works across NetBird / VPNs.
//   4. Toasts             - progress / done / error notices

(() => {
  'use strict';


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
    outgoing: new Map(),    // transferId -> { peerId, resolve, reject }
    incoming: new Map(),    // transferId -> { toast, peerName }
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

    if (msg.type === 'transfer-offer') return onTransferOffer(msg);
    if (msg.type === 'transfer-response') return onTransferResponse(msg);
    if (msg.type === 'transfer-ready') return onTransferReady(msg);
    if (msg.type === 'transfer-failed') return onTransferFailed(msg);
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
        failTransfersFor(id);
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
  // Transfer engine (HTTP relay through the LanDrop server)
  // ---------------------------------------------------------------------

  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-xxxx`);
  const peerName = (id) => state.peers.get(id)?.name || 'a device';

  // ----- sender side -----

  async function sendFilesTo(peerId, files) {
    const peerEl = state.peers.get(peerId)?.el;
    if (peerEl) peerEl.classList.add('sending');
    setLinkActive(peerId, true);

    for (const file of files) {
      const toast = createToast({
        title: `Sending ${file.name}`,
        sub: `to ${peerName(peerId)} — waiting for accept…`,
        icon: ICON_SEND,
      });
      try {
        await sendOneFile(peerId, file, toast);
        toast.setProgress(100);
        toast.setSub('Delivered');
        toast.done();
        toast.dismissAfter(3000);
      } catch (err) {
        const m = err && err.message;
        if (m === 'declined') toast.error(`${peerName(peerId)} declined the file`);
        else if (m === 'timeout') toast.error('No response — request timed out');
        else toast.error('Transfer failed — connection dropped');
        toast.dismissAfter(6000);
        break;
      }
    }

    if (peerEl) peerEl.classList.remove('sending');
    setLinkActive(peerId, false);
  }

  async function sendOneFile(peerId, file, toast) {
    const id = newId();

    // 1. Ask the receiver; wait for accept/decline.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.outgoing.delete(id);
        reject(new Error('timeout'));
      }, REQUEST_TIMEOUT_MS + 5000);
      state.outgoing.set(id, {
        peerId,
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (e) => { clearTimeout(timer); state.outgoing.delete(id); reject(e); },
      });
      sendSignal({
        type: 'transfer-offer', target: peerId, id,
        name: file.name, size: file.size, mime: file.type,
      });
    });

    // 2. Upload the raw file over HTTP (streams from disk, shows progress).
    try {
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', `/api/upload/${id}?peer=${encodeURIComponent(state.self.id)}`);
        xhr.upload.onprogress = (e) => {
          if (!e.lengthComputable) return;
          const pct = Math.floor((e.loaded / e.total) * 100);
          toast.setProgress(pct);
          toast.setSub(`to ${peerName(peerId)} — ${pct}%`);
        };
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('upload failed')));
        xhr.onerror = () => reject(new Error('upload failed'));
        xhr.onabort = () => reject(new Error('upload failed'));
        const o = state.outgoing.get(id);
        if (o) o.xhr = xhr;
        xhr.send(file);
      });
    } finally {
      state.outgoing.delete(id);
    }
  }

  function onTransferResponse(msg) {
    const o = state.outgoing.get(msg.id);
    if (!o) return;
    if (msg.accept) o.resolve();
    else o.reject(new Error('declined'));
  }

  // ----- receiver side -----

  async function onTransferOffer(msg) {
    const name = peerName(msg.sender);
    const accepted = await createRequestToast({
      title: `${name} wants to send a file`,
      sub: `${msg.name} — ${formatBytes(msg.size)}`,
      icon: ICON_RECEIVE,
    });
    sendSignal({ type: 'transfer-response', id: msg.id, accept: accepted });
    if (!accepted) return;

    const toast = createToast({
      title: `Receiving ${msg.name}`,
      sub: `from ${name} — waiting for upload…`,
      icon: ICON_RECEIVE,
    });
    state.incoming.set(msg.id, { toast, name: msg.name });
  }

  function onTransferReady(msg) {
    const inc = state.incoming.get(msg.id);
    if (!inc) return;
    state.incoming.delete(msg.id);

    // Let the browser stream the download straight to disk.
    const a = document.createElement('a');
    a.href = `/api/download/${msg.id}?peer=${encodeURIComponent(state.self.id)}`;
    a.download = inc.name;
    document.body.appendChild(a);
    a.click();
    a.remove();

    inc.toast.setProgress(100);
    inc.toast.setSub('Saved to your downloads');
    inc.toast.done();
    inc.toast.dismissAfter(4000);
  }

  function onTransferFailed(msg) {
    const o = state.outgoing.get(msg.id);
    if (o) {
      try { o.xhr && o.xhr.abort(); } catch {}
      o.reject(new Error('failed'));
    }
    const inc = state.incoming.get(msg.id);
    if (inc) {
      state.incoming.delete(msg.id);
      inc.toast.error('Transfer failed — sender disconnected');
      inc.toast.dismissAfter(6000);
    }
  }

  function failTransfersFor(peerId) {
    for (const [id, o] of state.outgoing) {
      if (o.peerId === peerId) onTransferFailed({ id });
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

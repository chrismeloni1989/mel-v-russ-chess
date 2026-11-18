// Camera & voice between Mel and Russ.
// Direct phone-to-phone video (WebRTC). The game server only passes the
// "hello" messages between the two phones; the video itself never touches it.
// Wi-Fi only: no relay server, so on mobile data the phones may not connect.

const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
const STALE_MS = 90000;      // an unanswered invite expires after this
const CONNECT_MS = 25000;    // give up connecting after this

let ctx = null;              // { post, me, oppName, toast }
let call = null;             // latest call record from the server
let pc = null;               // the live connection
let pcId = null;             // which call record pc belongs to
let local = null;            // my camera + mic stream
let want = false;            // I have pressed "Camera & voice"
let status = 'off';          // off | waiting | connecting | live | failed
let micOn = true, camOn = true;
let connectTimer = null;
let busy = false;
let lastActive = false;
let paused = false;          // camera/mic released while the game is in the background
let needTap = false;         // couldn't restart camera/mic by itself; ask for a tap
let sendIssue = false;       // our sound doesn't seem to be reaching the other phone
let blocked = false;         // the phone refused to play the other person's video/sound until tapped
const VERSION = '6';
const inst = Math.random().toString(36).slice(2);
const MEDIA = {
  video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 20 } },
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
};

// If the game is opened a second time on this phone, the older copy hands over camera & mic.
const bc = 'BroadcastChannel' in window ? new BroadcastChannel('mvr-call') : null;
if (bc) bc.onmessage = (e) => {
  if (e.data && e.data.claim && e.data.claim !== inst && (local || want)) {
    teardown(false); stopLocal(); want = false; paused = false; status = 'off';
    renderCall();
    ctx.toast('Camera & voice moved to your other window.');
  }
};     // so the game can switch layouts when a call starts or stops

const vMe = mkVideo(true);
const vOpp = mkVideo(false);
const hold = document.createElement('div');
hold.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;left:-10px;top:-10px';
hold.append(vMe, vOpp);
document.body.appendChild(hold);

function mkVideo(isMe) {
  const v = document.createElement('video');
  v.autoplay = true;
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  if (isMe) { v.muted = true; v.className = 'vid me'; } else v.className = 'vid opp';
  return v;
}

const icons = {
  cam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3"/></svg>',
  camOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3"/><path d="M2 3l20 18"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg>',
  micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/><path d="M3 3l18 18"/></svg>',
  end: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 9c-3.4 0-6.6 1-9.3 2.7-.5.3-.7 1-.5 1.5l1.3 2.6c.3.6 1 .8 1.6.6l2.8-1.1c.5-.2.8-.7.8-1.2V12c2.1-.7 4.5-.7 6.6 0v2.1c0 .5.3 1 .8 1.2l2.8 1.1c.6.2 1.3 0 1.6-.6l1.3-2.6c.2-.5 0-1.2-.5-1.5A17.6 17.6 0 0 0 12 9Z"/></svg>',
};

export function initCall(c) { ctx = c; }
export function callActive() { return want || status === 'live'; }
// Poll faster while two phones are introducing themselves.
export function fastPoll() { return status === 'waiting' || status === 'connecting'; }

const now = () => Date.now() + (ctx.offset ? ctx.offset() : 0);
const fresh = (c) => c && now() - c.at < STALE_MS;

/* ---------------- server updates ---------------- */
export function onCallData(c) {
  call = c || null;
  if (busy) { renderCall(); return; }

  // The other person hung up, or the record moved on without us.
  if (pc && (!call || call.id !== pcId)) {
    const theyEnded = !call;
    teardown(false);
    if (theyEnded && status === 'live') ctx.toast(`${ctx.oppName()} ended camera & voice`);
    status = want ? 'waiting' : 'off';
    if (theyEnded) { stopLocal(); want = false; status = 'off'; }
  }

  if (want && status !== 'failed') {
    const me = ctx.me();
    if (call && fresh(call) && call.from !== me && !call.answer && pcId !== call.id) {
      answer(call);                     // they invited and I'm ready: join
    } else if (pc && call && call.from === me && call.id === pcId && call.answer && !pc.remoteDescription) {
      pc.setRemoteDescription({ type: 'answer', sdp: call.answer }).catch(failed);
    } else if (!pc) {
      offer();                          // nothing to join: I invite
    }
  }
  renderCall();
}

/* ---------------- actions ---------------- */
async function start() {
  if (!navigator.mediaDevices || !window.RTCPeerConnection) {
    ctx.toast('This phone’s browser can’t do video calls. Try Safari or Chrome.');
    return;
  }
  if (bc) bc.postMessage({ claim: inst });            // free the camera from any other copy
  try {
    local = await getMedia();
  } catch (e) {
    ctx.toast('Camera or microphone was blocked. Allow them in your phone’s settings for this website.', 5000);
    return;
  }
  micOn = true; camOn = true; paused = false; needTap = false; sendIssue = false;
  vMe.srcObject = local;
  vMe.play().catch(() => {});
  vOpp.play().catch(() => {});        // unlock sound on iPhone while we have the tap
  want = true;
  status = 'waiting';
  onCallData(call);
}

function newPc(id) {
  teardown(false);
  pc = new RTCPeerConnection({ iceServers: ICE });
  pcId = id;
  local.getTracks().forEach((t) => pc.addTrack(t, local));
  pc.ontrack = (e) => {
    vOpp.srcObject = e.streams[0];
    playOpp();
  };
  pc.onconnectionstatechange = () => {
    const s = pc && pc.connectionState;
    if (s === 'connected') { status = 'live'; clearTimeout(connectTimer); renderCall(); }
    if (s === 'failed') failed();
    if (s === 'disconnected') {
      setTimeout(() => { if (pc && pc.connectionState === 'disconnected') failed(); }, 6000);
    }
  };
  status = 'connecting';
  clearTimeout(connectTimer);
  connectTimer = setTimeout(() => { if (status === 'connecting' && pc && pc.remoteDescription) failed(); }, CONNECT_MS);
  return pc;
}

// Gather all network routes first, so the invite goes over in one message.
function gathered(p) {
  if (p.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((res) => {
    const t = setTimeout(res, 2500);
    p.addEventListener('icegatheringstatechange', () => {
      if (p.iceGatheringState === 'complete') { clearTimeout(t); res(); }
    });
  });
}

async function offer() {
  busy = true;
  try {
    const id = Math.random().toString(36).slice(2, 10);
    const p = newPc(id);
    status = 'waiting';
    await p.setLocalDescription(await p.createOffer());
    await gathered(p);
    if (pc !== p) return;
    const r = await ctx.post({ type: 'call-offer', id, sdp: p.localDescription.sdp });
    call = r.call;
  } catch (e) { console.error(e); failed(); }
  finally { busy = false; renderCall(); }
}

async function answer(c) {
  busy = true;
  try {
    const p = newPc(c.id);
    await p.setRemoteDescription({ type: 'offer', sdp: c.offer });
    await p.setLocalDescription(await p.createAnswer());
    await gathered(p);
    if (pc !== p) return;
    const r = await ctx.post({ type: 'call-answer', id: c.id, sdp: p.localDescription.sdp });
    call = r.call;
  } catch (e) {
    if (/ended/.test(e.message)) { teardown(false); status = 'waiting'; }
    else { console.error(e); failed(); }
  }
  finally { busy = false; renderCall(); }
}

function failed() {
  if (status === 'failed') return;
  teardown(true);
  status = 'failed';
  renderCall();
}

function teardown(tellServer) {
  clearTimeout(connectTimer);
  if (pc) {
    pc.ontrack = null; pc.onconnectionstatechange = null;
    try { pc.close(); } catch {}
  }
  if (tellServer && pcId) ctx.post({ type: 'call-end', id: pcId }).catch(() => {});
  pc = null; pcId = null;
  vOpp.srcObject = null;
}

// Get camera & mic. If another copy of the game still holds them, ask it to let go and try again.
async function getMedia() {
  try {
    const st = await navigator.mediaDevices.getUserMedia(MEDIA);
    watchTracks(st);
    return st;
  } catch (e) {
    if (e && e.name === 'NotAllowedError') throw e;
    if (bc) bc.postMessage({ claim: inst });
    await new Promise((r) => setTimeout(r, 800));
    const st = await navigator.mediaDevices.getUserMedia(MEDIA);
    watchTracks(st);
    return st;
  }
}

function watchTracks(st) {
  st.getTracks().forEach((t) => t.addEventListener('ended', () => {
    if (want && local === st && !paused && !document.hidden) restartMedia().catch(() => { needTap = true; renderCall(); });
  }));
}

// Swap in fresh camera & mic without dropping the call.
async function restartMedia() {
  const fresh = await getMedia();
  fresh.getAudioTracks().forEach((t) => (t.enabled = micOn));
  fresh.getVideoTracks().forEach((t) => (t.enabled = camOn));
  if (pc) {
    for (const tr of pc.getTransceivers()) {
      const kind = tr.receiver && tr.receiver.track && tr.receiver.track.kind;
      const t = kind && fresh.getTracks().find((x) => x.kind === kind);
      if (t && tr.sender) await tr.sender.replaceTrack(t);
    }
  }
  const old = local;
  local = fresh;
  if (old) old.getTracks().forEach((t) => t.stop());
  vMe.srcObject = local;
  vMe.play().catch(() => {});
  paused = false; needTap = false; sendIssue = false; lastSent = null; stuck = 0;
  renderCall();
}

// Every few seconds, check our sound is actually going out.
let lastSent = null, stuck = 0;
setInterval(async () => {
  if (status !== 'live' || !pc || !local || document.hidden || paused) { lastSent = null; stuck = 0; return; }
  let sent = null;
  try {
    (await pc.getStats()).forEach((r) => { if (r.type === 'outbound-rtp' && r.kind === 'audio') sent = (sent || 0) + r.bytesSent; });
  } catch { return; }
  const dead = local.getAudioTracks().some((t) => t.readyState === 'ended');
  if (micOn && (dead || (sent !== null && lastSent !== null && sent <= lastSent))) stuck++; else stuck = 0;
  lastSent = sent;
  const issue = stuck >= 2;
  if (issue !== sendIssue) { sendIssue = issue; renderCall(); }
}, 3000);

function stopLocal() {
  if (local) local.getTracks().forEach((t) => t.stop());
  local = null;
  vMe.srcObject = null;
}

function hangUp() {
  want = false;
  const id = pcId || (call && call.from === ctx.me() ? call.id : null);
  teardown(false);
  if (id) ctx.post({ type: 'call-end', id }).catch(() => {});
  stopLocal();
  status = 'off';
  renderCall();
}

function toggle(kind) {
  if (!local) return;
  if (kind === 'mic') { micOn = !micOn; local.getAudioTracks().forEach((t) => (t.enabled = micOn)); }
  else { camOn = !camOn; local.getVideoTracks().forEach((t) => (t.enabled = camOn)); }
  renderCall();
}

// Leaving the game lets go of camera & mic (so nothing else gets stuck with them);
// coming back switches them on again and carries on the call.
document.addEventListener('visibilitychange', () => {
  if (!want) return;
  if (document.hidden) {
    if (local) { local.getTracks().forEach((t) => t.stop()); paused = true; }
  } else if (paused || (local && local.getTracks().some((t) => t.readyState === 'ended'))) {
    if (bc) bc.postMessage({ claim: inst });
    restartMedia().catch(() => { needTap = true; renderCall(); });
  }
});
window.addEventListener('pagehide', () => { if (local) local.getTracks().forEach((t) => t.stop()); });

/* ---------------- drawing ---------------- */
export function renderCall() {
  if (!ctx) return;
  const opp = ctx.oppName();
  const invited = !want && call && fresh(call) && call.from !== ctx.me() && !call.answer;
  const active = want || status === 'live';
  if (active !== lastActive) {
    lastActive = active;
    if (ctx.onActiveChange) { ctx.onActiveChange(); return; } // redraws, then comes back here
  }

  // place the two little videos
  const sOpp = document.querySelector('[data-slot="opp"]');
  const sMe = document.querySelector('[data-slot="me"]');
  place(vOpp, active ? sOpp : null);
  place(vMe, active ? sMe : null);
  document.querySelectorAll('[data-slot]').forEach((s) => s.classList.toggle('on', active));
  if (sOpp) {
    sOpp.dataset.state = status === 'live' ? 'live' : 'wait';
    sOpp.dataset.label = status === 'failed' ? 'No link' : status === 'live' ? '' : 'Waiting…';
  }
  if (sMe) sMe.classList.toggle('camoff', !camOn);
  if (sOpp) {
    let tp = sOpp.querySelector('.tapplay');
    if (blocked && status === 'live') {
      if (!tp) {
        tp = document.createElement('button');
        tp.className = 'tapplay';
        tp.addEventListener('click', () => playOpp(true).then(() => { blocked = false; renderCall(); }));
        sOpp.appendChild(tp);
      }
      tp.textContent = `Tap to see & hear ${opp}`;
    } else if (tp) tp.remove();
  }

  const bar = document.getElementById('callbar');
  if (!bar) return;
  let html = '';
  if (!active && !invited) {
    html = `<button class="cbtn start" data-call="start">${icons.cam}<span>Camera &amp; voice</span></button>`;
  } else if (invited) {
    html = `<button class="cbtn join" data-call="start">${icons.cam}<span>${opp} wants camera &amp; voice — <b>Join</b></span></button>`;
  } else {
    let note = '';
    if (status === 'waiting') note = ctx.oppOnline() ? `Waiting for ${opp} to tap Join…` : `Waiting for ${opp} to open the game…`;
    if (status === 'connecting') note = 'Connecting…';
    if (status === 'failed') note = 'Couldn’t connect. Camera &amp; voice needs you both on Wi-Fi.';
    const warn = needTap || sendIssue;
    if (warn && status !== 'failed') note = `${opp} may not be able to see or hear you — tap <b>↻</b>`;
    html = `
      <div class="ctrls">
        <button class="cround ${micOn ? '' : 'off'}" data-call="mic" aria-label="Microphone">${micOn ? icons.mic : icons.micOff}</button>
        <button class="cround ${camOn ? '' : 'off'}" data-call="cam" aria-label="Camera">${camOn ? icons.cam : icons.camOff}</button>
        ${status === 'failed' ? '<button class="cbtn retry" data-call="retry">Try again</button>'
          : `<button class="cround fix ${warn ? 'warn' : ''}" data-call="fix" aria-label="Restart my camera and microphone">↻</button>`}
        <button class="cround end" data-call="end" aria-label="End camera and voice">${icons.end}</button>
      </div>
      ${note ? `<div class="cnote">${note}</div>` : ''}`;
  }
  bar.innerHTML = html;
  bar.querySelectorAll('[data-call]').forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.call;
    if (a === 'start') start();
    if (a === 'fix') restartMedia().then(() => ctx.toast('Camera & mic restarted')).catch(() => ctx.toast('Couldn’t restart the camera. Close the browser fully and open the game again.', 5000));
    if (a === 'end') hangUp();
    if (a === 'mic' || a === 'cam') toggle(a);
    if (a === 'retry') { status = 'waiting'; teardown(false); onCallData(call && call.from === ctx.me() ? null : call); }
  }));
}

// Play the other person's video. Some phones (iPhones especially) refuse unless tapped:
// then show the picture silently if allowed, and put a 'tap to see & hear' button on it.
function playOpp(fromTap = false) {
  if (!vOpp.srcObject) return Promise.resolve();
  vOpp.muted = false;
  return vOpp.play().then(() => {
    if (blocked) { blocked = false; renderCall(); }
  }).catch(() => {
    if (fromTap) return;
    blocked = true;
    vOpp.muted = true;                 // at least show the picture
    vOpp.play().catch(() => {});
    renderCall();
  });
}
setInterval(() => {
  if (status === 'live' && vOpp.srcObject && !document.hidden && (vOpp.paused || vOpp.muted) && !blocked) {
    playOpp();
  }
}, 2000);

/* ---------------- call check (what each phone is sending / receiving) ---------------- */
function device() {
  const u = navigator.userAgent;
  const os = /iPhone|iPad/.test(u) ? `iPhone iOS ${((u.match(/OS (\d+)_(\d+)/) || []).slice(1).join('.')) || '?'}`
    : /Android/.test(u) ? `Android ${(u.match(/Android (\d+)/) || [])[1] || ''}` : 'Computer';
  const br = /SamsungBrowser/.test(u) ? 'Samsung Internet' : /CriOS|Chrome/.test(u) ? 'Chrome' : /FxiOS|Firefox/.test(u) ? 'Firefox' : /Safari/.test(u) ? 'Safari' : 'browser';
  return `${os}, ${br}`;
}
export async function myDiag() {
  const tr = (k) => {
    const t = local && local.getTracks().find((x) => x.kind === k);
    if (!t) return 'none';
    if (t.readyState === 'ended') return 'stopped';
    if (!t.enabled) return 'switched off';
    return t.muted ? 'blocked by phone' : 'on';
  };
  let sentA = 0, sentV = 0, recvA = 0, recvV = 0;
  if (pc) {
    try {
      (await pc.getStats()).forEach((r) => {
        if (r.type === 'outbound-rtp') { if (r.kind === 'audio') sentA += r.bytesSent || 0; else sentV += r.bytesSent || 0; }
        if (r.type === 'inbound-rtp') { if (r.kind === 'audio') recvA += r.bytesReceived || 0; else recvV += r.bytesReceived || 0; }
      });
    } catch {}
  }
  return {
    ver: VERSION, dev: device(), status, link: pc ? pc.connectionState : 'none',
    cam: tr('video'), mic: tr('audio'),
    sentA: Math.round(sentA / 1024), sentV: Math.round(sentV / 1024), recvA: Math.round(recvA / 1024), recvV: Math.round(recvV / 1024),
    showing: !!(vOpp.srcObject && !vOpp.paused && vOpp.videoWidth > 0), sound: !!(vOpp.srcObject && !vOpp.paused && !vOpp.muted),
    blocked, away: document.hidden,
  };
}
let diagCount = 0;
setInterval(async () => {
  if (!ctx || !(want || status === 'live')) { diagCount = 0; return; }
  if (diagCount++ % 2) return;                     // every ~6 seconds
  try { await ctx.post({ type: 'call-diag', d: await myDiag() }); } catch {}
}, 3000);

function place(v, slot) {
  const target = slot || hold;
  if (v.parentNode !== target) {
    target.appendChild(v);
    if (v === vOpp) playOpp(); else if (v.srcObject) v.play().catch(() => {});
  }
}

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
let lastActive = false;     // so the game can switch layouts when a call starts or stops

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
  try {
    local = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 20 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    ctx.toast('Camera or microphone was blocked. Allow them in your phone’s settings for this website.', 5000);
    return;
  }
  micOn = true; camOn = true;
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
    vOpp.play().catch(() => {});
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

// iPhone turns the camera off when you leave the page; offer a quick restart.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && local && local.getVideoTracks().some((t) => t.readyState === 'ended')) {
    hangUp();
    ctx.toast('Camera stopped while you were away. Tap Camera & voice to start again.', 4000);
  }
});

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
    html = `
      <div class="ctrls">
        <button class="cround ${micOn ? '' : 'off'}" data-call="mic" aria-label="Microphone">${micOn ? icons.mic : icons.micOff}</button>
        <button class="cround ${camOn ? '' : 'off'}" data-call="cam" aria-label="Camera">${camOn ? icons.cam : icons.camOff}</button>
        ${status === 'failed' ? '<button class="cbtn retry" data-call="retry">Try again</button>' : ''}
        <button class="cround end" data-call="end" aria-label="End camera and voice">${icons.end}</button>
      </div>
      ${note ? `<div class="cnote">${note}</div>` : ''}`;
  }
  bar.innerHTML = html;
  bar.querySelectorAll('[data-call]').forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.call;
    if (a === 'start') start();
    if (a === 'end') hangUp();
    if (a === 'mic' || a === 'cam') toggle(a);
    if (a === 'retry') { status = 'waiting'; teardown(false); onCallData(call && call.from === ctx.me() ? null : call); }
  }));
}

function place(v, slot) {
  const target = slot || hold;
  if (v.parentNode !== target) {
    target.appendChild(v);
    if (v.srcObject) v.play().catch(() => {});
  }
}

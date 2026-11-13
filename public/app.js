import { Chess } from '/vendor/chess.js';
import { initCall, onCallData, renderCall, fastPoll, callActive } from '/call.js';

/* ------------------------------------------------------------------ */
/* Basics                                                              */
/* ------------------------------------------------------------------ */
const NAMES = { mel: 'Mel', russ: 'Russ' };
const other = (p) => (p === 'mel' ? 'russ' : 'mel');
const UNDO_MS = 5000;
const POLL_MS = 2500;
const API = '/api/game';
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

const $view = document.getElementById('view');
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const params = new URLSearchParams(location.search);
const urlTok = params.get('p');
const savedTok = store.get('mvr-token');
let token = urlTok || savedTok;
// Opening someone else's link on this phone? Ask before switching.
let switchFrom = urlTok && savedTok && urlTok !== savedTok ? savedTok : null;
if (urlTok && !switchFrom) store.set('mvr-token', urlTok);

let S = null;                 // latest game state from the server
let offset = 0;               // server clock minus phone clock
let pres = { oppOnline: false, oppSeen: null };
let selected = null;          // square the player has tapped
let busy = false;
let pollCount = 0;
let pollTimer = null;
let undoTimer = null;
let tossShownAt = Number(store.get('mvr-toss-shown') || 0);
let tossAnim = null;          // { result, white, until }
let promoPick = null;         // { from, to }
let lastMoveCount = null;
let overDismissed = null;     // game number whose result card was tapped away

const serverNow = () => Date.now() + offset;

function toast(msg, ms = 2600) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/* ------------------------------------------------------------------ */
/* Server calls                                                        */
/* ------------------------------------------------------------------ */
async function getState(force = false) {
  const ping = force || pollCount % 4 === 0 ? 1 : 0;
  pollCount++;
  const v = force || !S ? 0 : S.v;
  const r = await fetch(`${API}?p=${encodeURIComponent(token || '')}&v=${v}&ping=${ping}`, { cache: 'no-store' });
  const data = await r.json();
  return { status: r.status, data };
}

async function post(body) {
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ p: token, ...body }),
  });
  const data = await r.json().catch(() => ({ error: 'No response from server.' }));
  if (!r.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

function absorb(data) {
  if (data.now) offset = data.now - Date.now();
  if ('oppOnline' in data) pres = { oppOnline: data.oppOnline, oppSeen: data.oppSeen };
  if (data.state) {
    const prev = S;
    S = data.state;
    noticeChanges(prev, S);
  }
}

function noticeChanges(prev, cur) {
  const n = cur.game ? cur.game.moves.length : 0;
  if (prev && prev.game && cur.game && prev.game.no === cur.game.no && n > (lastMoveCount ?? n)) {
    const last = cur.game.moves[n - 1];
    if (last.by !== cur.me && navigator.vibrate) navigator.vibrate(60);
  }
  lastMoveCount = n;
  if (cur.toss && cur.toss.at && cur.toss.at > tossShownAt && serverNow() - cur.toss.at < 15000) {
    tossShownAt = cur.toss.at;
    store.set('mvr-toss-shown', String(tossShownAt));
    tossAnim = { result: cur.toss.result, white: cur.game.white, until: Date.now() + 4200 };
    setTimeout(() => { tossAnim = null; render(); }, 4300);
  }
}

async function poll(force = false) {
  clearTimeout(pollTimer);
  if (!document.hidden || force) {
    try {
      const { status, data } = await getState(force);
      if (status === 403 && switchFrom) { token = switchFrom; switchFrom = null; history.replaceState(null, '', '/?p=' + token); return poll(true); }
      if (status === 403) { store.del('mvr-token'); store.del('mvr-me'); token = null; renderNoAccess(); return; }
      if (data.needsSetup) { renderSetup(); return; }
      const changed = !!data.state;
      if (switchFrom && data.state) {
        const was = store.get('mvr-me');
        const now = data.state.me;
        if (was && was !== now && !confirm(`This link is ${NAMES[now]}'s, but this phone plays as ${NAMES[was]}.\n\nSwitch this phone to ${NAMES[now]}?\n\n(Tap Cancel to stay as ${NAMES[was]}.)`)) {
          token = switchFrom; switchFrom = null;
          history.replaceState(null, '', '/?p=' + token);
          return poll(true);
        }
        store.set('mvr-token', token);
      store.set('mvr-me', me);
        switchFrom = null;
      }
      if (data.state) store.set('mvr-me', data.state.me);
      absorb(data);
      if (changed || force) render(); else renderPresence();
      if ('call' in data) onCallData(data.call);
    } catch {
      // network blip — just try again next time
    }
  }
  pollTimer = setTimeout(() => poll(), fastPoll() ? 1000 : POLL_MS);
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && token) poll(true); });

async function act(body) {
  if (busy) return;
  busy = true;
  try {
    const data = await post(body);
    absorb(data);
  } catch (e) {
    toast(e.message);
    await poll(true);
  } finally {
    busy = false;
    render();
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function chessFor(game) {
  const c = new Chess();
  for (const m of game.moves) c.move({ from: m.from, to: m.to, promotion: m.promotion });
  return c;
}

function captures(chess) {
  const taken = { w: [], b: [] }; // pieces captured BY white / BY black
  for (const m of chess.history({ verbose: true })) {
    if (m.captured) taken[m.color].push(m.captured);
  }
  for (const k of ['w', 'b']) taken[k].sort((a, b) => VALUE[b] - VALUE[a]);
  return taken;
}

function waLink(text) {
  const num = (store.get('mvr-opp-phone') || '').replace(/\D/g, '').replace(/^0/, '44');
  return `https://wa.me/${num}?text=${encodeURIComponent(text)}`;
}

function ago(ts) {
  if (!ts) return null;
  const s = Math.max(0, Math.round((serverNow() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hr${h > 1 ? 's' : ''} ago`;
  return `${Math.round(h / 24)} days ago`;
}

const icon = {
  wa: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3Z"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
};

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */
function renderNoAccess() {
  clearTimeout(pollTimer);
  $view.innerHTML = `
    <div class="panel">
      <h2>Private game</h2>
      <p>This board is just for Mel and Russ. Open your own private link — the one you were sent on WhatsApp — and you'll go straight to the game.</p>
      <p>Lost it? Ask the other player to open the menu (☰) and send you your link again.</p>
      <a class="btn ghost" href="/how.html">How it works</a>
    </div>`;
}

function renderSetup() {
  clearTimeout(pollTimer);
  $view.innerHTML = `
    <div class="panel">
      <h2>Let's set up the board</h2>
      <p>This only happens once. Each of you gets a private link, so nobody can move the other person's pieces.</p>
      <p><b style="color:var(--text)">Who are you?</b></p>
      <div class="row">
        <button class="btn primary" data-me="mel">I'm Mel</button>
        <button class="btn primary" data-me="russ">I'm Russ</button>
      </div>
    </div>`;
  $view.querySelectorAll('[data-me]').forEach((b) => b.addEventListener('click', async () => {
    const me = b.dataset.me;
    try {
      const { links } = await post({ type: 'setup' });
      const mine = links[me], theirs = links[other(me)];
      token = new URL(mine).searchParams.get('p');
      store.set('mvr-token', token);
      $view.innerHTML = `
        <div class="panel">
          <h2>All set, ${NAMES[me]}</h2>
          <p><b style="color:var(--text)">1. Your private link.</b> Bookmark it or add it to your home screen.</p>
          <div class="linkbox">${mine}</div>
          <button class="btn" id="copyMine">Copy my link</button>
          <p><b style="color:var(--text)">2. Send ${NAMES[other(me)]} theirs.</b></p>
          <a class="btn wa" target="_blank" rel="noopener" href="${waLink(`♟️ Fancy a game, ${NAMES[other(me)]}? Here's your private link for Mel v Russ chess — keep it safe:\n${theirs}`)}">${icon.wa} Send ${NAMES[other(me)]} their link</a>
          <a class="btn primary" href="${mine}">3. Go to the board</a>
        </div>`;
      document.getElementById('copyMine').onclick = () => copy(mine);
    } catch (e) {
      toast(e.message);
      setTimeout(() => location.reload(), 1500);
    }
  }));
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch { prompt('Copy this link:', text); }
}

/* ------------------------------------------------------------------ */
/* Main game render                                                    */
/* ------------------------------------------------------------------ */
function render() {
  if (!S) return;
  clearInterval(undoTimer);
  const me = S.me, opp = other(me);
  const g = S.game;
  const callMode = !!g && callActive();
  document.body.classList.toggle('callmode', callMode);
  let html = callMode ? '' : scoreHtml();

  if (!g && S.phase === 'idle') {
    html += callStrip() + `
      <div class="panel">
        <h2>Ready for the first game?</h2>
        <p>Tap below to start. ${NAMES[opp]} then tosses a coin: <b style="color:var(--text)">heads</b> and you're White, <b style="color:var(--text)">tails</b> and ${NAMES[opp]} is. White always moves first. After that, who starts swaps every game.</p>
        <button class="btn primary" data-act="new">Start a new game</button>
      </div>`;
  } else if (S.phase === 'toss') {
    html += callStrip() + tossPanel();
  } else if (g) {
    html += gameHtml(callMode);
  }

  $view.innerHTML = html;
  wire();
  renderCall();
  const chip = document.getElementById('youChip');
  if (chip) { chip.textContent = `You're ${NAMES[me]}`; chip.hidden = false; }
  document.title = (S.phase === 'play' && isMyTurn()) || (S.phase === 'toss' && S.toss.tosser === me)
    ? '● Your move · Mel v Russ' : 'Mel v Russ';
}

function callStrip() {
  return `
    <div class="callstrip">
      <div class="vslot" data-slot="opp" data-name="${NAMES[other(S.me)]}"></div>
      <div class="vslot" data-slot="me" data-name="You"></div>
    </div>
    <div class="callbar" id="callbar"></div>`;
}

function scoreHtml() {
  return `
    <div class="score">
      <div class="who"><span class="name">Mel</span><span class="num">${S.score.mel}</span></div>
      <div class="mid"><b>${S.score.draws}</b>draw${S.score.draws === 1 ? '' : 's'}</div>
      <div class="who"><span class="name">Russ</span><span class="num">${S.score.russ}</span></div>
    </div>`;
}

function presenceText() {
  const opp = NAMES[other(S.me)];
  if (pres.oppOnline) return `${opp} is here now`;
  const a = ago(pres.oppSeen);
  return a ? `${opp} last here ${a}` : `${opp} hasn't opened the game yet`;
}

function renderPresence() {
  const el = document.getElementById('presence');
  if (el) el.textContent = presenceText();
  const dot = document.getElementById('oppDot');
  if (dot) dot.classList.toggle('on', pres.oppOnline);
}

function tossPanel() {
  const me = S.me, t = S.toss;
  if (t.tosser === me) {
    return `
      <div class="panel center">
        <h2>Your toss, ${NAMES[me]}</h2>
        <p><b style="color:var(--text)">Heads</b>: ${NAMES[t.initiator]} is White. <b style="color:var(--text)">Tails</b>: you're White. White moves first.</p>
        <div class="coinwrap"><div class="coin idle"><div class="face heads">HEADS</div><div class="face tails">TAILS</div></div></div>
        <button class="btn primary" data-act="toss">Toss the coin</button>
        <p class="presence" id="presence">${presenceText()}</p>
      </div>`;
  }
  return `
    <div class="panel center">
      <h2>Waiting for the coin toss</h2>
      <p>${NAMES[t.tosser]} tosses the coin. <b style="color:var(--text)">Heads</b> and you're White, <b style="color:var(--text)">tails</b> and ${NAMES[t.tosser]} is. If you're both here, you'll see it land.</p>
      <div class="coinwrap"><div class="coin idle"><div class="face heads">HEADS</div><div class="face tails">TAILS</div></div></div>
      <p class="presence"><span class="dot ${pres.oppOnline ? 'on' : ''}" id="oppDot" style="display:inline-block;margin-right:6px"></span><span id="presence">${presenceText()}</span></p>
      <a class="btn wa" target="_blank" rel="noopener" href="${waLink(`🪙 New game, ${NAMES[t.tosser]}! Your turn to toss the coin:\n${S.oppLink}`)}">${icon.wa} Tell ${NAMES[t.tosser]} on WhatsApp</a>
    </div>`;
}

function isMyTurn() {
  const g = S.game;
  if (!g || S.phase !== 'play') return false;
  const turn = g.moves.length % 2 === 0 ? 'w' : 'b';
  return (turn === 'w' ? g.white : g.black) === S.me;
}

function gameHtml(callMode = false) {
  const me = S.me, opp = other(me), g = S.game;
  const chess = chessFor(g);
  const myColor = g.white === me ? 'w' : 'b';
  const oppColor = myColor === 'w' ? 'b' : 'w';
  const taken = captures(chess);
  const material = (arr) => arr.reduce((t, p) => t + VALUE[p], 0);
  const adv = material(taken[myColor]) - material(taken[oppColor]);

  const capsHtml = (color, a) => `
    <div class="caps">${taken[color].map((p) => `<i class="pc-${color === 'w' ? 'b' : 'w'}${p}"></i>`).join('')}${a > 0 ? `<span class="adv">+${a}</span>` : ''}</div>`;

  const bar = (who, color, isOpp) => `
    <div class="pbar">
      <div class="vslot" data-slot="${isOpp ? 'opp' : 'me'}"></div>
      <span class="pname">${isOpp ? `<span class="dot ${pres.oppOnline ? 'on' : ''}" id="oppDot"></span>` : ''}${NAMES[who]}
        <span class="chip ${color}">${color === 'w' ? 'White' : 'Black'}</span></span>
      ${capsHtml(color, isOpp ? -adv : adv)}
    </div>`;

  // status line
  let status = '', cls = '', sub = '';
  const turnColor = chess.turn();
  const turnPlayer = turnColor === 'w' ? g.white : g.black;
  if (S.phase === 'play') {
    if (chess.inCheck()) {
      status = turnPlayer === me ? 'Check! Your king is under attack' : `Check! ${NAMES[opp]}'s king is under attack`;
      cls = 'check';
    } else if (turnPlayer === me) {
      status = 'Your move'; cls = 'mine';
    } else {
      status = `${NAMES[opp]}'s move`;
    }
    sub = presenceText();
    if (g.moves.length === 0) {
      const coin = g.no === 1 && S.toss && S.toss.result ? `Coin landed ${S.toss.result}. ` : '';
      sub = coin + (turnPlayer === me ? "You're White, so you start." : `${NAMES[opp]} is White and starts.`);
    }
  } else if (S.phase === 'over') {
    status = resultText(g.result, me);
    sub = `Next game: ${NAMES[S.nextWhite]} is White and starts.`;
  }

  // overlay for finished game or coin toss
  let overlay = '';
  if (tossAnim && Date.now() < tossAnim.until) {
    overlay = `
      <div class="overlay"><div class="card">
        <div class="coinwrap"><div class="coin spin-${tossAnim.result}"><div class="face heads">HEADS</div><div class="face tails">TAILS</div></div></div>
        <div class="big" style="font-size:28px;text-transform:capitalize">${tossAnim.result}!</div>
        <div class="small">${NAMES[tossAnim.white]} is White and moves first.</div>
      </div></div>`;
  } else if (S.phase === 'over' && overDismissed !== g.no) {
    const r = g.result;
    const big = r.winner ? (r.reason === 'checkmate' ? 'Checkmate!' : `${NAMES[other(r.winner)]} resigned`) : 'Draw';
    const small = r.winner ? (r.winner === me ? 'You win! 🏆' : `${NAMES[r.winner]} wins`) : `by ${r.reason}`;
    overlay = `<div class="overlay" id="overOverlay"><div class="card"><div class="big">${big}</div><div class="small">${small}</div><div class="small" style="margin-top:12px;font-size:12px">Tap to see the board</div></div></div>`;
  }

  // actions
  const actions = [];
  const last = g.moves[g.moves.length - 1];
  const undoLeft = last && last.by === me && g.result?.reason !== 'resigned' ? UNDO_MS - (serverNow() - last.at) : 0;
  if (undoLeft > 0) {
    actions.push(`<button class="btn undo" data-act="undo" id="undoBtn">${icon.undo} Undo last move <span class="bar" id="undoBar" style="width:${(undoLeft / UNDO_MS) * 100}%"></span></button>`);
  }
  if (S.phase === 'play' && turnPlayer === opp && g.moves.length > 0) {
    const lastSan = last ? last.san : '';
    const msg = chess.inCheck()
      ? `♟️ Check! Your move, ${NAMES[opp]} — I played ${lastSan}.\n${S.oppLink}`
      : `♟️ Your move, ${NAMES[opp]} — I played ${lastSan}.\n${S.oppLink}`;
    actions.push(`<a class="btn wa ${pres.oppOnline ? 'ghost' : ''}" target="_blank" rel="noopener" href="${waLink(msg)}">${icon.wa} ${pres.oppOnline ? `${NAMES[opp]} is here — no need to message` : `Tell ${NAMES[opp]} it's their turn`}</a>`);
  }
  if (S.phase === 'play' && turnPlayer === opp && g.moves.length === 0) {
    actions.push(`<a class="btn wa" target="_blank" rel="noopener" href="${waLink(`♟️ New game, ${NAMES[opp]} — you're White, so it's your move!\n${S.oppLink}`)}">${icon.wa} Tell ${NAMES[opp]} it's their move</a>`);
  }
  if (S.phase === 'over') {
    actions.push(`<button class="btn primary" data-act="new">Start next game</button>`);
  }

  if (callMode) {
    // Compact layout for camera & voice: everything fits on one screen, no scrolling.
    let short = status;
    if (S.phase === 'play' && cls === 'check') short = turnPlayer === me ? 'Check! Your move' : `Check! ${NAMES[opp]}'s move`;
    const undo = undoLeft > 0
      ? `<button class="btn undo mini" data-act="undo" id="undoBtn">${icon.undo} Undo <span class="bar" id="undoBar" style="width:${(undoLeft / UNDO_MS) * 100}%"></span></button>` : '';
    const draws = S.score.draws ? ` <span class="dr">· ${S.score.draws} draw${S.score.draws === 1 ? '' : 's'}</span>` : '';
    return `
    <div class="callhead">
      <div class="vslot big" data-slot="opp"><div class="vslot pip" data-slot="me"></div></div>
      <div class="cside">
        <div class="crow">
          <span class="pname"><span class="dot ${pres.oppOnline ? 'on' : ''}" id="oppDot"></span>${NAMES[opp]}
            <span class="chip ${oppColor}">${oppColor === 'w' ? 'White' : 'Black'}</span></span>
          <button class="iconbtn sm" id="menuBtn2" aria-label="Menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
        </div>
        ${capsHtml(oppColor, -adv)}
        <div class="cscore">Mel <b>${S.score.mel}</b> – <b>${S.score.russ}</b> Russ${draws}</div>
        <div class="status small ${cls}">${short}</div>
        <div class="callbar" id="callbar"></div>
      </div>
    </div>
    <div class="boardwrap">
      ${boardHtml(chess, myColor)}
      ${overlay}
    </div>
    <div class="pbar mine">
      <span class="pname">${NAMES[me]} <span class="chip ${myColor}">${myColor === 'w' ? 'White' : 'Black'}</span></span>
      ${undo}
      ${capsHtml(myColor, adv)}
    </div>
    ${S.phase === 'over' ? '<div class="actions"><button class="btn primary" data-act="new">Start next game</button></div>' : ''}
    ${promoPick ? promoSheet(myColor) : ''}`;
  }

  return `
    ${bar(opp, oppColor, true)}
    <div class="boardwrap">
      ${boardHtml(chess, myColor)}
      ${overlay}
    </div>
    ${bar(me, myColor, false)}
    <div class="callbar" id="callbar"></div>
    <div class="status ${cls}">${status}</div>
    <div class="sub" id="presence">${sub}</div>
    <div class="actions">${actions.join('')}</div>
    ${promoPick ? promoSheet(myColor) : ''}`;
}

function resultText(r, me) {
  if (!r) return '';
  if (!r.winner) return `Draw — ${r.reason}`;
  const how = r.reason === 'checkmate' ? 'by checkmate' : `— ${NAMES[other(r.winner)]} resigned`;
  return r.winner === me ? `You won ${how}` : `${NAMES[r.winner]} won ${how}`;
}

function boardHtml(chess, myColor) {
  const files = 'abcdefgh';
  const ranks = myColor === 'w' ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  const fileOrder = myColor === 'w' ? files.split('') : files.split('').reverse();
  const g = S.game;
  const last = g.moves[g.moves.length - 1];
  let checkSq = null;
  if (chess.inCheck()) {
    const t = chess.turn();
    for (const row of chess.board()) for (const p of row) if (p && p.type === 'k' && p.color === t) checkSq = p.square;
  }
  let targets = new Map();
  if (selected) {
    for (const m of chess.moves({ square: selected, verbose: true })) targets.set(m.to, !!m.captured);
  }
  let out = '<div class="board" id="board">';
  ranks.forEach((r, ri) => {
    fileOrder.forEach((f, fi) => {
      const sq = f + r;
      const light = (files.indexOf(f) + r) % 2 === 1;
      const p = chess.get(sq);
      const classes = ['sq', light ? 'l' : 'd'];
      if (last && (last.from === sq || last.to === sq)) classes.push('last');
      if (selected === sq) classes.push('sel');
      if (checkSq === sq) classes.push('check');
      if (targets.has(sq)) classes.push('hint', targets.get(sq) ? 'cap' : '');
      out += `<button class="${classes.join(' ')}" data-sq="${sq}" aria-label="${sq}">`;
      if (p) out += `<span class="pc pc-${p.color}${p.type}"></span>`;
      if (ri === 7) out += `<span class="coord f">${f}</span>`;
      if (fi === 0) out += `<span class="coord r">${r}</span>`;
      out += '</button>';
    });
  });
  return out + '</div>';
}

function promoSheet(color) {
  return `
    <div class="sheet-bg" id="promoBg"><div class="sheet">
      <h3>Promote your pawn to…</h3>
      <div class="promo">${['q', 'r', 'b', 'n'].map((t) => `<button class="pc-${color}${t}" data-promo="${t}" aria-label="${t}"></button>`).join('')}</div>
      <button class="btn ghost" id="promoCancel">Cancel</button>
    </div></div>`;
}

/* ------------------------------------------------------------------ */
/* Interaction                                                         */
/* ------------------------------------------------------------------ */
function wire() {
  $view.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
    const type = b.dataset.act;
    if (type === 'toss') {
      const coin = $view.querySelector('.coin');
      if (coin) coin.className = 'coin spin-heads';
    }
    selected = null;
    act({ type });
  }));

  const board = document.getElementById('board');
  if (board) board.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sq]');
    if (b) tap(b.dataset.sq);
  });

  const m2 = document.getElementById('menuBtn2');
  if (m2) m2.addEventListener('click', () => document.getElementById('menuBtn').click());

  const over = document.getElementById('overOverlay');
  if (over) over.addEventListener('click', () => { overDismissed = S.game.no; over.remove(); });

  if (promoPick) {
    $view.querySelectorAll('[data-promo]').forEach((b) => b.addEventListener('click', () => {
      const { from, to } = promoPick;
      promoPick = null;
      move(from, to, b.dataset.promo);
    }));
    document.getElementById('promoCancel').onclick = () => { promoPick = null; selected = null; render(); };
  }

  const undoBtn = document.getElementById('undoBtn');
  if (undoBtn) {
    undoTimer = setInterval(() => {
      const last = S.game?.moves[S.game.moves.length - 1];
      const left = last ? UNDO_MS - (serverNow() - last.at) : 0;
      const bar = document.getElementById('undoBar');
      if (left <= 0 || !bar) { clearInterval(undoTimer); render(); return; }
      bar.style.width = `${(left / UNDO_MS) * 100}%`;
    }, 100);
  }
}

function tap(sq) {
  if (!isMyTurn() || busy) return;
  const g = S.game;
  const chess = chessFor(g);
  const myColor = g.white === S.me ? 'w' : 'b';
  const p = chess.get(sq);

  if (selected) {
    const mv = chess.moves({ square: selected, verbose: true }).find((m) => m.to === sq);
    if (mv) {
      if (mv.flags.includes('p')) { promoPick = { from: selected, to: sq }; render(); return; }
      move(selected, sq);
      return;
    }
  }
  if (p && p.color === myColor && chess.moves({ square: sq }).length) selected = sq === selected ? null : sq;
  else selected = null;
  render();
}

function move(from, to, promotion) {
  // Show the move straight away, then confirm with the server.
  const chess = chessFor(S.game);
  let mv;
  try { mv = chess.move({ from, to, promotion }); } catch { selected = null; render(); return; }
  S = structuredClone(S);
  S.game.moves.push({ from, to, promotion: mv.promotion, san: mv.san, by: S.me, at: serverNow() });
  selected = null;
  lastMoveCount = S.game.moves.length;
  render();
  act({ type: 'move', from, to, promotion });
}

/* ------------------------------------------------------------------ */
/* Menu                                                                */
/* ------------------------------------------------------------------ */
document.getElementById('menuBtn').addEventListener('click', () => {
  if (!S) { location.href = '/how.html'; return; }
  const opp = NAMES[other(S.me)];
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = `
    <div class="sheet">
      <h3>Menu</h3>
      <a class="btn" href="/how.html">How it works</a>
      <button class="btn" id="mCopy">Copy my private link</button>
      <a class="btn wa" target="_blank" rel="noopener" href="${waLink(`♟️ Here's your private link for Mel v Russ chess, ${opp} — keep it safe:\n${S.oppLink}`)}">${icon.wa} Re-send ${opp} their link</a>
      <label for="mPhone">${opp}'s WhatsApp number (optional — opens their chat directly)</label>
      <input id="mPhone" inputmode="tel" placeholder="e.g. 07700 900123" value="${store.get('mvr-opp-phone') || ''}">
      ${S.phase === 'play' ? '<button class="btn danger ghost" id="mResign">Resign this game</button>' : ''}
      <button class="btn danger ghost" id="mReset">Start over (new links, score 0–0)</button>
      <button class="btn ghost" id="mClose">Close</button>
    </div>`;
  document.body.appendChild(bg);
  const close = () => {
    store.set('mvr-opp-phone', bg.querySelector('#mPhone').value.trim());
    bg.remove();
    render();
  };
  bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
  bg.querySelector('#mClose').onclick = close;
  bg.querySelector('#mCopy').onclick = () => copy(S.myLink);
  bg.querySelector('#mReset').onclick = async () => {
    const typed = prompt(`Start over from scratch?\n\nThis wipes the scoreboard and the current game, and both private links stop working. You'll set up again and send ${opp} a new link.\n\nType RESET to confirm.`);
    if (!typed || typed.trim().toUpperCase() !== 'RESET') return;
    try {
      await post({ type: 'reset' });
      ['mvr-token', 'mvr-me', 'mvr-toss-shown'].forEach((k) => store.del(k));
      location.href = '/';
    } catch (e) { toast(e.message); }
  };
  const r = bg.querySelector('#mResign');
  if (r) r.onclick = () => {
    if (confirm(`Resign this game? ${opp} gets the win.`)) { close(); act({ type: 'resign' }); }
  };
});

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */
initCall({
  post,
  toast,
  me: () => S && S.me,
  oppName: () => (S ? NAMES[other(S.me)] : ''),
  oppOnline: () => pres.oppOnline,
  offset: () => offset,
  onActiveChange: () => render(),
});
if (token) poll(true);
else {
  fetch(API).then((r) => r.json()).then((d) => (d.needsSetup ? renderSetup() : renderNoAccess()))
    .catch(() => renderNoAccess());
}

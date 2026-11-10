// Game rules for Mel v Russ. Pure functions: (state, action) -> new state.
// Shared by the Netlify function; the chess rules themselves come from chess.js.
import { Chess } from 'chess.js';

export const PLAYERS = ['mel', 'russ'];
export const NAMES = { mel: 'Mel', russ: 'Russ' };
export const UNDO_MS = 5000;        // what the players see
const UNDO_GRACE_MS = 1500;         // allowance for a slow phone signal

export const other = (p) => (p === 'mel' ? 'russ' : 'mel');

export class GameError extends Error {}
const fail = (msg) => { throw new GameError(msg); };

function token() {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return Buffer.from(a).toString('base64url');
}

export function newState() {
  return {
    v: 1,
    tokens: { mel: token(), russ: token() },
    score: { mel: 0, russ: 0, draws: 0 },
    phase: 'idle',            // idle | toss | play | over
    firstTossDone: false,
    nextWhite: null,          // who is White in the next game (after the first toss)
    toss: null,               // { initiator, tosser, result, at }
    game: null,               // { no, white, black, moves: [...], result }
    gamesPlayed: 0,
  };
}

export function whoIs(state, tok) {
  if (!tok) return null;
  return PLAYERS.find((p) => state.tokens[p] === tok) || null;
}

export function replay(moves) {
  const c = new Chess();
  for (const m of moves) c.move({ from: m.from, to: m.to, promotion: m.promotion });
  return c;
}

function finishIfOver(state, chess, mover) {
  const g = state.game;
  let result = null;
  if (chess.isCheckmate()) result = { winner: mover, reason: 'checkmate' };
  else if (chess.isStalemate()) result = { winner: null, reason: 'stalemate' };
  else if (chess.isInsufficientMaterial()) result = { winner: null, reason: 'insufficient material' };
  else if (chess.isThreefoldRepetition()) result = { winner: null, reason: 'threefold repetition' };
  else if (chess.isDrawByFiftyMoves()) result = { winner: null, reason: '50-move rule' };
  if (result) endGame(state, result);
  return g;
}

function endGame(state, result) {
  state.game.result = result;
  state.phase = 'over';
  if (result.winner) state.score[result.winner] += 1; else state.score.draws += 1;
  state.gamesPlayed += 1;
  state.nextWhite = state.game.black; // starter alternates, starter is always White
}

function unEndGame(state) {
  const r = state.game.result;
  if (!r) return;
  if (r.winner) state.score[r.winner] -= 1; else state.score.draws -= 1;
  state.gamesPlayed -= 1;
  state.game.result = null;
  state.phase = 'play';
}

function startGame(state, white) {
  const prevNo = state.game ? state.game.no : 0;
  state.game = { no: prevNo + 1, white, black: other(white), moves: [], result: null, startedAt: Date.now() };
  state.phase = 'play';
}

export function apply(state, me, action, now = Date.now()) {
  const s = structuredClone(state);
  switch (action.type) {
    case 'new': {
      if (s.phase === 'play') fail('A game is already in progress.');
      if (s.phase === 'toss') fail('Waiting for the coin toss.');
      if (!s.firstTossDone) {
        s.phase = 'toss';
        s.toss = { initiator: me, tosser: other(me), result: null, at: null };
      } else {
        startGame(s, s.nextWhite);
      }
      break;
    }
    case 'toss': {
      if (s.phase !== 'toss') fail('There is no coin toss waiting.');
      if (me !== s.toss.tosser) fail(`${NAMES[s.toss.tosser]} tosses the coin.`);
      const a = new Uint8Array(1);
      crypto.getRandomValues(a);
      const result = a[0] % 2 === 0 ? 'heads' : 'tails';
      s.toss.result = result;
      s.toss.at = now;
      s.firstTossDone = true;
      // Heads: the player who started the game is White. Tails: the tosser is White.
      startGame(s, result === 'heads' ? s.toss.initiator : s.toss.tosser);
      break;
    }
    case 'move': {
      if (s.phase !== 'play') fail('No game in progress.');
      const g = s.game;
      const chess = replay(g.moves);
      const turnPlayer = chess.turn() === 'w' ? g.white : g.black;
      if (me !== turnPlayer) fail(`It's ${NAMES[turnPlayer]}'s move.`);
      let mv;
      try {
        mv = chess.move({ from: action.from, to: action.to, promotion: action.promotion || 'q' });
      } catch { fail('That move is not allowed.'); }
      g.moves.push({ from: mv.from, to: mv.to, promotion: mv.promotion, san: mv.san, by: me, at: now });
      finishIfOver(s, chess, me);
      break;
    }
    case 'undo': {
      const g = s.game;
      if (!g || !g.moves.length) fail('Nothing to undo.');
      const last = g.moves[g.moves.length - 1];
      if (last.by !== me) fail('You can only undo your own last move.');
      if (now - last.at > UNDO_MS + UNDO_GRACE_MS) fail('Too late — undo only works for 5 seconds.');
      if (g.result && g.result.reason === 'resigned') fail('Cannot undo after a resignation.');
      if (g.result) unEndGame(s);
      g.moves.pop();
      break;
    }
    case 'resign': {
      if (s.phase !== 'play') fail('No game in progress.');
      endGame(s, { winner: other(me), reason: 'resigned' });
      break;
    }
    default:
      fail('Unknown action.');
  }
  s.v = state.v + 1;
  return s;
}

// What a player is allowed to see (never the other player's token,
// except as part of the WhatsApp link we build for them).
export function view(state, me, siteUrl) {
  const { tokens, ...rest } = state;
  return {
    ...rest,
    me,
    myLink: `${siteUrl}/?p=${tokens[me]}`,
    oppLink: `${siteUrl}/?p=${tokens[other(me)]}`,
  };
}

const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Teacher password (set via environment variable TEACHER_PASSWORD) ──────
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || 'lehrer2024';

// ── Game State ────────────────────────────────────────────────────────────
let state = freshState();

function freshState() {
  return {
    phase:           'briefing',
    timer:           0,
    verdicts:        { A: null, B: null, C: null },
    createdProfiles: [],   // solutions NEVER leave the server until results phase
    votes:           {},
    scores:          {},
    clients:         {},
  };
}

// ── Sanitize: strip all HTML tags from user input ─────────────────────────
function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .slice(0, 500);   // hard length cap
}

// ── Build the state object sent to regular clients (solutions stripped) ───
function publicState() {
  const showSolutions = state.phase === 'results';
  return {
    phase:   state.phase,
    timer:   state.timer,
    verdicts: state.verdicts,
    clients:  state.clients,
    votes:    state.votes,
    scores:   state.scores,
    createdProfiles: state.createdProfiles.map(p => ({
      id:         p.id,
      createdBy:  p.createdBy,
      handle:     p.handle,
      bio:        p.bio,
      post:       p.post,
      // solution and solutionReason only sent once phase = results
      solution:       showSolutions ? p.solution       : undefined,
      solutionReason: showSolutions ? p.solutionReason : undefined,
    })),
  };
}

// ── WebSocket broadcast ───────────────────────────────────────────────────
function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); });
}

function broadcastState() {
  const pub = publicState();
  wss.clients.forEach(c => {
    if (c.readyState !== WebSocket.OPEN) return;
    // Teacher clients get the full state including solutions
    const payload = c.isTeacher
      ? { type: 'STATE', state: { ...pub,
          createdProfiles: state.createdProfiles  // full, with solutions
        }}
      : { type: 'STATE', state: pub };
    c.send(JSON.stringify(payload));
  });
}

// ── Timer ─────────────────────────────────────────────────────────────────
let timerInterval = null;

function startTimer(seconds) {
  if (timerInterval) clearInterval(timerInterval);
  state.timer = seconds;
  timerInterval = setInterval(() => {
    state.timer--;
    broadcast({ type: 'TIMER', timer: state.timer });
    if (state.timer <= 0) { clearInterval(timerInterval); timerInterval = null; }
  }, 1000);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// ── WebSocket handlers ────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  const clientId = Math.random().toString(36).slice(2, 9);
  ws.clientId  = clientId;
  ws.isTeacher = false;
  ws.joinedGroup = null;

  // Send current public state on connect
  ws.send(JSON.stringify({ type: 'WELCOME', clientId, state: publicState() }));

  ws.on('message', (raw) => {
    // Ignore oversized messages (basic DoS protection)
    if (raw.length > 4096) return;

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── Teacher authentication ──────────────────────────────────────────
      case 'AUTH_TEACHER': {
        if (msg.password === TEACHER_PASSWORD) {
          ws.isTeacher = true;
          ws.send(JSON.stringify({ type: 'AUTH_OK' }));
          // Send full state (with solutions) to this teacher client
          ws.send(JSON.stringify({ type: 'STATE', state: {
            ...publicState(),
            createdProfiles: state.createdProfiles,
          }}));
        } else {
          ws.send(JSON.stringify({ type: 'AUTH_FAIL' }));
        }
        break;
      }

      // ── Client joins ────────────────────────────────────────────────────
      case 'JOIN': {
        const allowedGroups = ['A', 'B', 'C'];
        const group = msg.group;
        if (!allowedGroups.includes(group)) break;
        const name = sanitize(msg.name) || 'Anonym';
        ws.joinedGroup = group;
        state.clients[clientId] = { group, name };
        broadcastState();
        break;
      }

      // ── Phase 1: verdict ────────────────────────────────────────────────
      case 'SUBMIT_VERDICT': {
        if (state.phase !== 'analysis') break;
        // Group can only submit for their own assigned account
        const clientGroup = state.clients[clientId]?.group;
        if (!clientGroup) break;
        const allowed = ['SPERREN', 'VERWARNEN', 'FREIGEBEN'];
        if (!allowed.includes(msg.verdict)) break;
        state.verdicts[clientGroup] = {
          verdict: msg.verdict,
          laws:    Array.isArray(msg.laws) ? msg.laws.slice(0, 6).map(sanitize) : [],
          reason:  sanitize(msg.reason),
          group:   clientGroup,
        };
        broadcastState();
        break;
      }

      // ── Phase 2: create profile ─────────────────────────────────────────
      case 'SUBMIT_PROFILE': {
        if (state.phase !== 'create') break;
        const clientGroup = state.clients[clientId]?.group;
        if (!clientGroup) break;
        const allowed = ['SPERREN', 'VERWARNEN', 'FREIGEBEN'];
        if (!allowed.includes(msg.solution)) break;
        // One profile per group – prevent overwriting another group's profile
        const existing = state.createdProfiles.find(p => p.createdBy === clientGroup);
        if (existing) {
          // Allow updating only if same client
          if (existing.submittedBy !== clientId) break;
          state.createdProfiles = state.createdProfiles.filter(p => p.createdBy !== clientGroup);
        }
        state.createdProfiles.push({
          id:             clientGroup + '_' + Date.now(),
          createdBy:      clientGroup,
          submittedBy:    clientId,           // lock to this client
          handle:         sanitize(msg.handle),
          bio:            sanitize(msg.bio),
          post:           sanitize(msg.post),
          solution:       msg.solution,       // stays on server until results
          solutionReason: sanitize(msg.solutionReason),
        });
        broadcastState();
        break;
      }

      // ── Phase 3: vote ───────────────────────────────────────────────────
      case 'SUBMIT_VOTE': {
        if (state.phase !== 'vote') break;
        const clientGroup = state.clients[clientId]?.group;
        if (!clientGroup) break;
        const profile = state.createdProfiles.find(p => p.id === msg.profileId);
        if (!profile) break;
        // Can't vote on your own group's profile
        if (profile.createdBy === clientGroup) break;
        const allowed = ['SPERREN', 'VERWARNEN', 'FREIGEBEN'];
        if (!allowed.includes(msg.verdict)) break;
        if (!state.votes[clientId]) state.votes[clientId] = {};
        state.votes[clientId][msg.profileId] = msg.verdict;
        broadcastState();
        break;
      }

      // ── Teacher-only actions ────────────────────────────────────────────
      case 'SET_PHASE': {
        if (!ws.isTeacher) break;   // ← only teachers can change phase
        const allowed = ['briefing','analysis','create','vote','results'];
        if (!allowed.includes(msg.phase)) break;
        state.phase = msg.phase;
        if (msg.phase === 'analysis') startTimer(20 * 60);
        if (msg.phase === 'create')   startTimer(10 * 60);
        if (msg.phase === 'vote')     startTimer(10 * 60);
        if (msg.phase === 'results')  { stopTimer(); computeScores(); }
        broadcastState();
        break;
      }

      case 'RESET': {
        if (!ws.isTeacher) break;   // ← only teachers can reset
        stopTimer();
        state = freshState();
        broadcastState();
        break;
      }
    }
  });

  ws.on('close', () => {
    delete state.clients[clientId];
    broadcastState();
  });
});

// ── Score calculation ─────────────────────────────────────────────────────
function computeScores() {
  const scores = {};
  Object.entries(state.votes).forEach(([cid, clientVotes]) => {
    const group = state.clients[cid]?.group;
    Object.entries(clientVotes).forEach(([profileId, voted]) => {
      const profile = state.createdProfiles.find(p => p.id === profileId);
      if (!profile) return;
      if (profile.createdBy === group) return;  // no self-scoring
      if (voted === profile.solution) {
        scores[cid] = (scores[cid] || 0) + 1;
      }
    });
  });
  state.scores = scores;
}

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`SocialGuard läuft auf Port ${PORT}`);
  console.log(`Teacher-Passwort: ${TEACHER_PASSWORD}`);
});

const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/ws' });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.get('/health', (req, res) => res.send('OK'));

const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || 'lehrer2024';
const VALID_ACCOUNTS   = ['A', 'B', 'C'];
const VALID_VERDICTS   = ['SPERREN', 'VERWARNEN', 'FREIGEBEN'];

let state = freshState();

function freshState() {
  return {
    phase:           'briefing',
    timer:           0,
    clients:         {},   // clientId → { name, account }
    verdicts:        {},   // clientId → { verdict, laws, reason, account }
    createdProfiles: [],   // { id, createdBy(clientId), account, handle, bio, post, solution, solutionReason }
    votes:           {},   // clientId → { profileId → verdict }
    scores:          {},   // clientId → points
  };
}

function sanitize(str, max = 500) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
    .slice(0, max);
}

// State sent to regular clients – solutions hidden until results
function publicState() {
  const showSolutions = state.phase === 'results';
  return {
    phase:    state.phase,
    timer:    state.timer,
    clients:  state.clients,
    verdicts: state.verdicts,
    votes:    state.votes,
    scores:   state.scores,
    createdProfiles: state.createdProfiles.map(p => ({
      id:         p.id,
      createdBy:  p.createdBy,
      account:    p.account,
      handle:     p.handle,
      bio:        p.bio,
      post:       p.post,
      solution:       showSolutions ? p.solution       : undefined,
      solutionReason: showSolutions ? p.solutionReason : undefined,
    })),
  };
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); });
}

function broadcastState() {
  wss.clients.forEach(c => {
    if (c.readyState !== WebSocket.OPEN) return;
    const full = c.isTeacher
      ? { ...publicState(), createdProfiles: state.createdProfiles }
      : publicState();
    c.send(JSON.stringify({ type: 'STATE', state: full }));
  });
}

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

wss.on('connection', (ws) => {
  const clientId = Math.random().toString(36).slice(2, 9);
  ws.clientId  = clientId;
  ws.isTeacher = false;

  ws.send(JSON.stringify({ type: 'WELCOME', clientId, state: publicState() }));

  ws.on('message', (raw) => {
    if (raw.length > 4096) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'AUTH_TEACHER':
        if (msg.password === TEACHER_PASSWORD) {
          ws.isTeacher = true;
          ws.send(JSON.stringify({ type: 'AUTH_OK' }));
          ws.send(JSON.stringify({ type: 'STATE', state: { ...publicState(), createdProfiles: state.createdProfiles } }));
        } else {
          ws.send(JSON.stringify({ type: 'AUTH_FAIL' }));
        }
        break;

      case 'JOIN': {
        if (!VALID_ACCOUNTS.includes(msg.account)) break;
        const name = sanitize(msg.name || 'Anonym', 30);
        ws.account = msg.account;
        state.clients[clientId] = { name, account: msg.account };
        broadcastState();
        break;
      }

      case 'SUBMIT_VERDICT': {
        if (state.phase !== 'analysis') break;
        const client = state.clients[clientId];
        if (!client) break;
        if (!VALID_VERDICTS.includes(msg.verdict)) break;
        // Each client submits their own verdict
        state.verdicts[clientId] = {
          verdict: msg.verdict,
          laws:    Array.isArray(msg.laws) ? msg.laws.slice(0, 6).map(s => sanitize(s, 60)) : [],
          reason:  sanitize(msg.reason),
          account: client.account,
          name:    client.name,
        };
        broadcastState();
        break;
      }

      case 'SUBMIT_PROFILE': {
        if (state.phase !== 'create') break;
        const client = state.clients[clientId];
        if (!client) break;
        if (!VALID_VERDICTS.includes(msg.solution)) break;
        // One profile per client (can update own)
        state.createdProfiles = state.createdProfiles.filter(p => p.createdBy !== clientId);
        state.createdProfiles.push({
          id:             clientId + '_' + Date.now(),
          createdBy:      clientId,
          creatorName:    client.name,
          account:        client.account,
          handle:         sanitize(msg.handle, 60),
          bio:            sanitize(msg.bio, 150),
          post:           sanitize(msg.post, 600),
          solution:       msg.solution,
          solutionReason: sanitize(msg.solutionReason, 300),
        });
        broadcastState();
        break;
      }

      case 'SUBMIT_VOTE': {
        if (state.phase !== 'vote') break;
        const client = state.clients[clientId];
        if (!client) break;
        const profile = state.createdProfiles.find(p => p.id === msg.profileId);
        if (!profile) break;
        if (profile.createdBy === clientId) break;  // no self-voting
        if (!VALID_VERDICTS.includes(msg.verdict)) break;
        if (!state.votes[clientId]) state.votes[clientId] = {};
        state.votes[clientId][msg.profileId] = msg.verdict;
        broadcastState();
        break;
      }

      case 'SET_PHASE': {
        if (!ws.isTeacher) break;
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

      case 'RESET':
        if (!ws.isTeacher) break;
        stopTimer();
        state = freshState();
        broadcastState();
        break;
    }
  });

  ws.on('close', () => {
    delete state.clients[clientId];
    broadcastState();
  });
});

function computeScores() {
  const scores = {};
  Object.entries(state.votes).forEach(([cid, clientVotes]) => {
    Object.entries(clientVotes).forEach(([profileId, voted]) => {
      const profile = state.createdProfiles.find(p => p.id === profileId);
      if (!profile) return;
      if (profile.createdBy === cid) return;
      if (voted === profile.solution) {
        scores[cid] = (scores[cid] || 0) + 1;
      }
    });
  });
  state.scores = scores;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`SocialGuard läuft auf Port ${PORT}`);
  console.log(`Teacher-Passwort: ${TEACHER_PASSWORD}`);
});

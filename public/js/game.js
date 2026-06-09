/* ── Card Rendering ─────────────────────────────────────────────────── */
const SUIT_SYM = { coins:'♦', cups:'♥', swords:'♠', clubs:'♣' };
const VAL_LABEL = { 1:'A', 8:'Q', 9:'J', 10:'K' };
const FACE_ICONS = { 8:['♛','QUEEN'], 9:['♞','JACK'], 10:['♚','KING'] };

// Pip positions as [left%, top%] — standard playing card layout
// true = flip 180° (bottom-half pips)
const PIP_POS = {
  1: [[50,50]],
  2: [[50,22],[50,78,true]],
  3: [[50,22],[50,50],[50,78,true]],
  4: [[28,22],[72,22],[28,78,true],[72,78,true]],
  5: [[28,22],[72,22],[50,50],[28,78,true],[72,78,true]],
  6: [[28,22],[72,22],[28,50],[72,50],[28,78,true],[72,78,true]],
  7: [[28,22],[72,22],[50,35],[28,50],[72,50],[28,78,true],[72,78,true]],
};

function valLabel(v) { return VAL_LABEL[v] || String(v); }

function makeCardEl(card, extra='') {
  const el = document.createElement('div');
  el.className = `card suit-${card.suit}${extra ? ' '+extra : ''}`;
  const sym = SUIT_SYM[card.suit];
  const vl = valLabel(card.value);
  const corner = `<div class="card-corner"><span class="card-val">${vl}</span><span class="card-suit-small">${sym}</span></div><div class="card-corner-br"><span class="card-val">${vl}</span><span class="card-suit-small">${sym}</span></div>`;

  if (card.value >= 8) {
    const [icon, label] = FACE_ICONS[card.value];
    el.innerHTML = corner + `<div class="card-face">
      <div class="card-face-suits top">${sym} ${sym} ${sym}</div>
      <div class="card-face-icon">${icon}</div>
      <div class="card-face-label">${label}</div>
      <div class="card-face-suits bot">${sym} ${sym} ${sym}</div>
    </div>`;
  } else {
    const positions = PIP_POS[card.value] || [[50,50]];
    let pipsHtml = '<div class="card-pips">';
    for (const pos of positions) {
      const [lp, tp, flip] = pos;
      const cls = flip ? 'pip flip' : 'pip';
      pipsHtml += `<span class="${cls}" style="left:${lp}%;top:${tp}%">${sym}</span>`;
    }
    pipsHtml += '</div>';
    el.innerHTML = corner + pipsHtml;
  }
  return el;
}

/* ── State ───────────────────────────────────────────────────────────── */
const socket = io();
let myCode = null;
let gameState = null;
let selectedHandIndex = null;
let selectedTableIndices = new Set();

/* ── Screen Management ───────────────────────────────────────────────── */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function showError(elId, msg) {
  const el = document.getElementById(elId);
  if (el) { el.textContent = msg; setTimeout(() => el.textContent = '', 3000); }
}
function showToast(msg, duration = 2500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.add('hidden'), duration);
}

/* ── Lobby ───────────────────────────────────────────────────────────── */
document.getElementById('btn-host').addEventListener('click', () => {
  const name = document.getElementById('input-name').value.trim();
  if (!name) return showError('lobby-error', 'Enter your name first');
  socket.emit('create_room', { name });
});

document.getElementById('btn-join').addEventListener('click', () => {
  const name = document.getElementById('input-name').value.trim();
  const code = document.getElementById('input-code').value.trim();
  if (!name) return showError('lobby-error', 'Enter your name first');
  if (!code || code.length !== 4) return showError('lobby-error', 'Enter a 4-digit room code');
  socket.emit('join_room', { name, code });
});

socket.on('room_created', ({ code }) => {
  myCode = code;
  document.getElementById('display-code').textContent = code;
  showScreen('screen-waiting');
});
socket.on('room_joined', ({ code }) => {
  myCode = code;
  document.getElementById('display-code').textContent = code;
  showScreen('screen-waiting');
});
socket.on('error', ({ message }) => {
  showError('lobby-error', message);
  showToast(message);
});

/* ── Waiting Room ───────────────────────────────────────────────────── */
document.getElementById('btn-start').addEventListener('click', () => {
  socket.emit('start_game', { code: myCode });
});

socket.on('player_left', ({ name }) => {
  showToast(`${name} left the game`);
});

/* ── Start Game Button ──────────────────────────────────────────────── */
document.getElementById('btn-new-game').addEventListener('click', () => {
  // Reload to restart
  location.reload();
});

/* ── Main State Handler ─────────────────────────────────────────────── */
socket.on('game_state', (state) => {
  gameState = state;
  console.log('game_state received:', state.phase, 'myIndex:', state.myIndex, 'players:', state.players.map(p => `${p.name}(host=${p.isHost})`));
  renderState(state);
});

socket.on('scopa_announce', ({ playerName }) => {
  showToast(`✨ SCOPA! ${playerName} cleared the table!`, 3000);
});

socket.on('cards_dealt', ({ isLastDeal }) => {
  // Flash a deal notification
  showToast(isLastDeal ? '🂠 Last cards dealt!' : '🂠 Cards dealt!', 1500);
  if (isLastDeal) {
    // Three knocks — visual pulse on table area
    let count = 0;
    const table = document.querySelector('.table-area');
    const knock = () => {
      if (!table) return;
      table.classList.add('knock');
      setTimeout(() => table.classList.remove('knock'), 250);
      count++;
      if (count < 3) setTimeout(knock, 500);
    };
    setTimeout(knock, 400);
  }
  // Animate hand cards dealing in
  setTimeout(() => {
    document.querySelectorAll('.hand-cards .card').forEach((el, i) => {
      el.style.animation = 'none';
      el.offsetHeight; // reflow
      el.style.animation = `deal-in 0.3s ease ${i * 0.08}s forwards`;
      el.style.opacity = '0';
      setTimeout(() => { el.style.opacity = ''; }, (i * 80) + 300);
    });
  }, 100);
});

socket.on('play_result', ({ playerName, playedCard, capturedCards, isScopa, isTrail, isLastCapture }) => {
  const overlay = document.getElementById('play-result-overlay');
  const playerEl = document.getElementById('play-result-player');
  const cardsEl = document.getElementById('play-result-cards');
  const labelEl = document.getElementById('play-result-label');

  cardsEl.innerHTML = '';

  if (isLastCapture) {
    // Last round: player collects remaining table cards
    playerEl.textContent = playerName;
    capturedCards.forEach(c => cardsEl.appendChild(makeCardEl(c)));
    labelEl.textContent = '🂠 Collects remaining cards';
    labelEl.className = 'play-result-label';
  } else {
    playerEl.textContent = playerName;
    if (playedCard) cardsEl.appendChild(makeCardEl(playedCard));

    if (!isTrail && capturedCards.length > 0) {
      const arrow = document.createElement('span');
      arrow.className = 'play-result-arrow';
      arrow.textContent = '→';
      cardsEl.appendChild(arrow);
      capturedCards.forEach(c => cardsEl.appendChild(makeCardEl(c)));
      labelEl.textContent = isScopa ? '✨ SCOPA!' : 'Captured!';
      labelEl.className = 'play-result-label' + (isScopa ? ' scopa' : '');
    } else {
      labelEl.textContent = 'Thrown to table';
      labelEl.className = 'play-result-label trail';
    }
  }

  overlay.classList.remove('hidden');
  clearTimeout(overlay._tid);
  overlay._tid = setTimeout(() => overlay.classList.add('hidden'), isScopa ? 3000 : 2200);
});

socket.on('player_replaced', ({ name, botName }) => {
  showToast(`${name} left — replaced by 🤖 ${botName}`, 3500);
});

// ── Game Log ──────────────────────────────────────────────────────────
const gameLogEntries = [];
socket.on('game_log', ({ text }) => {
  gameLogEntries.unshift(text); // newest first
  if (gameLogEntries.length > 3) gameLogEntries.pop();
  renderGameLog();
});
function renderGameLog() {
  const el = document.getElementById('game-log');
  if (!el) return;
  el.innerHTML = '<div class="game-log-title">Log</div>';
  gameLogEntries.forEach((entry, i) => {
    const div = document.createElement('div');
    div.className = 'game-log-entry' + (i === 0 ? ' latest' : '');
    div.textContent = entry;
    el.appendChild(div);
  });
}

function renderState(state) {
  switch (state.phase) {
    case 'lobby':      renderWaiting(state); break;
    case 'shuffle':    renderCeremony(state); break;
    case 'cut':        renderCeremony(state); break;
    case 'playing':    renderGame(state); break;
    case 'round_end':  renderRoundEnd(state); break;
    case 'game_end':   renderGameEnd(state); break;
  }
}

/* ── Waiting ────────────────────────────────────────────────────────── */
/* ── Waiting ────────────────────────────────────────────────────────── */
let pendingTeams = {};

function renderWaiting(state) {
  showScreen('screen-waiting');
  document.getElementById('display-code').textContent = state.code;
  const container = document.getElementById('waiting-players');
  container.innerHTML = '';
  for (const p of state.players) {
    const chip = document.createElement('div');
    const classes = ['waiting-player-chip'];
    if (p.isHost) classes.push('host');
    if (p.isBot) classes.push('bot');
    chip.className = classes.join(' ');
    chip.textContent = p.isBot ? `🤖 ${p.name}` : p.name;
    container.appendChild(chip);
  }
  const isHost = state.myIndex >= 0 && state.players[state.myIndex]?.isHost;
  const count = state.players.length;
  const botCount = state.players.filter(p => p.isBot).length;

  document.getElementById('waiting-hint').textContent =
    count < 2 ? 'Waiting for players… (need at least 2)' : `${count} player${count > 1 ? 's' : ''} ready`;

  const botRow = document.getElementById('bot-row');
  if (isHost) {
    botRow.classList.remove('hidden');
    document.getElementById('btn-add-bot').disabled = count >= 4;
    document.getElementById('btn-remove-bot').disabled = botCount === 0;
  } else {
    botRow.classList.add('hidden');
  }

  const teamSection = document.getElementById('team-section');
  if (isHost && count === 4) {
    teamSection.classList.remove('hidden');
    renderTeamGrid(state);
  } else {
    teamSection.classList.add('hidden');
  }

  const startBtn = document.getElementById('btn-start');
  const needsTeams = count === 4 && state.teams === null;
  if (isHost && count >= 2 && !needsTeams) startBtn.classList.remove('hidden');
  else startBtn.classList.add('hidden');

  const waitErr = document.getElementById('waiting-error');
  if (waitErr) waitErr.textContent = needsTeams && isHost ? 'Assign teams before starting (4 players)' : '';
}

function renderTeamGrid(state) {
  const grid = document.getElementById('team-grid');
  grid.innerHTML = '';
  if (Object.keys(pendingTeams).length !== state.players.length) {
    state.players.forEach((_, i) => pendingTeams[i] = i < 2 ? 0 : 1);
  }
  state.players.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'team-row';
    const name = document.createElement('span');
    name.className = 'team-row-name';
    name.textContent = p.isBot ? `🤖 ${p.name}` : p.name;
    const btn0 = document.createElement('button');
    btn0.className = `team-btn${pendingTeams[i] === 0 ? ' active-0' : ''}`;
    btn0.textContent = 'Team A';
    btn0.onclick = () => { pendingTeams[i] = 0; renderTeamGrid(state); };
    const btn1 = document.createElement('button');
    btn1.className = `team-btn${pendingTeams[i] === 1 ? ' active-1' : ''}`;
    btn1.textContent = 'Team B';
    btn1.onclick = () => { pendingTeams[i] = 1; renderTeamGrid(state); };
    row.appendChild(name); row.appendChild(btn0); row.appendChild(btn1);
    grid.appendChild(row);
  });
  const teamDisplay = document.getElementById('team-display');
  if (state.teams !== null) {
    teamDisplay.classList.remove('hidden');
    const teamA = state.players.filter(p => p.teamIndex === 0).map(p => p.name).join(' & ');
    const teamB = state.players.filter(p => p.teamIndex === 1).map(p => p.name).join(' & ');
    teamDisplay.innerHTML = `<span class="team-chip team-chip-0">A: ${teamA}</span><span class="team-chip team-chip-1">B: ${teamB}</span>`;
  } else {
    teamDisplay.classList.add('hidden');
  }
}

document.getElementById('btn-confirm-teams').addEventListener('click', () => {
  const vals = Object.values(pendingTeams);
  if (vals.filter(v => v === 0).length !== 2 || vals.filter(v => v === 1).length !== 2) {
    const e = document.getElementById('waiting-error');
    if (e) e.textContent = 'Each team needs exactly 2 players';
    return;
  }
  socket.emit('set_teams', { code: myCode, teamAssignments: Object.values(pendingTeams) });
});

document.getElementById('btn-clear-teams').addEventListener('click', () => {
  pendingTeams = {};
  socket.emit('clear_teams', { code: myCode });
});

document.getElementById('btn-add-bot').addEventListener('click', () => {
  socket.emit('add_bot', { code: myCode });
});
document.getElementById('btn-remove-bot').addEventListener('click', () => {
  socket.emit('remove_bot', { code: myCode });
});

/* ── Ceremony ───────────────────────────────────────────────────────── */
function renderCeremony(state) {
  showScreen('screen-ceremony');
  const msg = document.getElementById('ceremony-message');
  const btnShuffle = document.getElementById('btn-shuffle');
  const btnCut = document.getElementById('btn-cut');
  const deck = document.getElementById('ceremony-deck');
  const dealerName = state.players[state.dealerIndex]?.name || '';
  const n = state.players.length;
  const cutterIndex = (state.dealerIndex - 1 + n) % n;
  const cutterName = state.players[cutterIndex]?.name || '';
  const myName = state.players[state.myIndex]?.name || '';
  const amDealer = state.myIndex === state.dealerIndex;
  const amCutter = state.myIndex === cutterIndex;

  btnShuffle.classList.add('hidden');
  btnCut.classList.add('hidden');
  deck.classList.remove('shuffling');

  if (state.phase === 'shuffle') {
    if (amDealer) {
      msg.textContent = `You are the dealer.\nShuffle the deck!`;
      btnShuffle.classList.remove('hidden');
    } else {
      msg.textContent = `${dealerName} is shuffling the deck…`;
    }
  } else if (state.phase === 'cut') {
    if (amCutter) {
      msg.textContent = `Cut the deck, ${myName}!`;
      btnCut.classList.remove('hidden');
    } else {
      msg.textContent = `Waiting for ${cutterName} to cut the deck…`;
    }
  }
}

document.getElementById('btn-shuffle').addEventListener('click', () => {
  const deck = document.getElementById('ceremony-deck');
  deck.classList.add('shuffling');
  setTimeout(() => {
    socket.emit('shuffle_done', { code: myCode });
  }, 1300);
});

document.getElementById('btn-cut').addEventListener('click', () => {
  socket.emit('cut_done', { code: myCode });
});

/* ── Game ────────────────────────────────────────────────────────────── */
function renderGame(state) {
  showScreen('screen-game');
  if (state.myIndex !== state.currentPlayerIndex) {
    selectedHandIndex = null;
    selectedTableIndices.clear();
    document.getElementById('capture-bar').classList.add('hidden');
    updateThrowButton(false);
  }

  renderScores(state);
  renderTable(state);
  renderHand(state);
  renderTurnBanner(state);
  renderDeckCount(state);
  renderLastCaptureHint(state);
}

function renderDeckCount(state) {
  const num = document.getElementById('deck-count-num');
  const el = document.getElementById('deck-count');
  if (!num || !el) return;
  num.textContent = state.deckCount;
  el.classList.toggle('empty', state.deckCount === 0);
}

function renderLastCaptureHint(state) {
  const el = document.getElementById('last-capture-hint');
  if (!el) return;
  if (state.isLastDeal && state.lastCapturePlayerIndex !== null) {
    const name = state.players[state.lastCapturePlayerIndex]?.name;
    el.textContent = `Last capture: ${name}`;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

function renderScores(state) {
  const strip = document.getElementById('scores-strip');
  strip.innerHTML = '';

  // In team mode, show team scores side by side with a separator
  if (state.teams) {
    // Both teammates have identical scores — just read from the first member
    const teamScores = [0, 1].map(t =>
      state.players.find(p => p.teamIndex === t)?.score ?? 0);

    state.players.forEach((p, i) => {
      const chip = document.createElement('div');
      chip.className = 'score-chip' +
        (i === state.currentPlayerIndex ? ' my-turn' : '') +
        (i === state.dealerIndex ? ' is-dealer' : '') +
        (p.teamIndex === 0 ? ' team-0' : ' team-1');
      chip.innerHTML = `
        <span class="score-chip-name">${p.name}</span>
        <span class="score-chip-pts">${teamScores[p.teamIndex]}</span>
        ${p.scopas > 0 ? `<span class="score-chip-scopas">✨×${p.scopas}</span>` : ''}
      `;
      strip.appendChild(chip);
    });
  } else {
    state.players.forEach((p, i) => {
      const chip = document.createElement('div');
      chip.className = 'score-chip' +
        (i === state.currentPlayerIndex ? ' my-turn' : '') +
        (i === state.dealerIndex ? ' is-dealer' : '');
      chip.innerHTML = `
        <span class="score-chip-name">${p.name}</span>
        <span class="score-chip-pts">${p.score}</span>
        ${p.scopas > 0 ? `<span class="score-chip-scopas">✨×${p.scopas}</span>` : ''}
      `;
      strip.appendChild(chip);
    });
  }
}

function renderTable(state) {
  const container = document.getElementById('table-cards');
  container.innerHTML = '';
  state.table.forEach((card, i) => {
    const el = makeCardEl(card);
    el.dataset.index = i;
    if (selectedTableIndices.has(i)) el.classList.add('selected-table');
    el.addEventListener('click', () => onTableCardClick(i));
    container.appendChild(el);
  });
}

function renderHand(state) {
  const container = document.getElementById('hand-cards');
  container.innerHTML = '';
  const myPlayer = state.players[state.myIndex];
  if (!myPlayer?.hand) return;
  const isMyTurn = state.myIndex === state.currentPlayerIndex;

  myPlayer.hand.forEach((card, i) => {
    const extraClass = isMyTurn ? 'playable' : 'dimmed';
    const el = makeCardEl(card, extraClass);
    if (i === selectedHandIndex) el.classList.add('selected-hand');
    el.addEventListener('click', () => { if (isMyTurn) onHandCardClick(i); });
    container.appendChild(el);
  });
}

function renderTurnBanner(state) {
  const banner = document.getElementById('turn-banner');
  const cp = state.players[state.currentPlayerIndex];
  if (!cp) return;
  if (state.myIndex === state.currentPlayerIndex) {
    banner.textContent = '⭐ Your turn';
  } else {
    banner.textContent = `${cp.name}'s turn`;
  }
}

/* ── Interaction ─────────────────────────────────────────────────────── */
function onHandCardClick(index) {
  // Block plays while capture animation is showing
  if (!document.getElementById('play-result-overlay').classList.contains('hidden')) return;
  const state = gameState;
  if (!state || state.myIndex !== state.currentPlayerIndex) return;
  const myHand = state.players[state.myIndex].hand;
  const card = myHand[index];
  const captures = findCaptures(card.value, state.table);

  if (captures.length === 0) {
    // No capture possible: select card and show "Throw" button
    if (selectedHandIndex === index) {
      // Already selected — deselect
      selectedHandIndex = null;
      updateThrowButton(false);
    } else {
      selectedHandIndex = index;
      updateThrowButton(true);
    }
    renderGame(state);
    return;
  }

  // Rule: if a direct value match exists on the table, auto-capture it — no choice
  const directMatchIdx = state.table.findIndex(t => t.value === card.value);
  if (directMatchIdx !== -1) {
    socket.emit('play_card', { code: myCode, cardIndex: index, captureIndices: [directMatchIdx] });
    return;
  }

  // Only sum-combos: single unambiguous option → auto
  if (captures.length === 1) {
    socket.emit('play_card', { code: myCode, cardIndex: index, captureIndices: captures[0] });
    return;
  }

  // Multiple sum-combo options: let player select table cards manually
  if (selectedHandIndex === index) {
    selectedHandIndex = null;
    selectedTableIndices.clear();
    document.getElementById('capture-bar').classList.add('hidden');
    document.getElementById('btn-confirm-capture').classList.add('hidden');
    document.getElementById('btn-throw-card').classList.add('hidden');
  } else {
    selectedHandIndex = index;
    selectedTableIndices.clear();
    // Show capture bar with confirm button (not throw button)
    document.getElementById('capture-bar').classList.remove('hidden');
    document.getElementById('btn-confirm-capture').classList.remove('hidden');
    document.getElementById('btn-throw-card').classList.add('hidden');
    document.querySelector('.capture-hint').textContent = 'Select table cards to capture';
  }
  renderGame(state);
}

function updateThrowButton(show) {
  const bar = document.getElementById('capture-bar');
  const throwBtn = document.getElementById('btn-throw-card');
  const confirmBtn = document.getElementById('btn-confirm-capture');
  const hint = document.querySelector('.capture-hint');
  if (show) {
    bar.classList.remove('hidden');
    throwBtn.classList.remove('hidden');
    confirmBtn.classList.add('hidden');
    if (hint) hint.textContent = 'No captures available';
  } else {
    bar.classList.add('hidden');
    throwBtn.classList.add('hidden');
    confirmBtn.classList.add('hidden');
    if (hint) hint.textContent = 'Select table cards to capture';
  }
}

function onTableCardClick(index) {
  const state = gameState;
  if (!state || selectedHandIndex === null) return;
  const myHand = state.players[state.myIndex].hand;
  const card = myHand[selectedHandIndex];
  const captures = findCaptures(card.value, state.table);
  if (captures.length === 0) return;

  // Toggle selection
  if (selectedTableIndices.has(index)) {
    selectedTableIndices.delete(index);
  } else {
    selectedTableIndices.add(index);
  }
  renderGame(state);
}

document.getElementById('btn-throw-card').addEventListener('click', () => {
  if (selectedHandIndex === null) return;
  socket.emit('play_card', { code: myCode, cardIndex: selectedHandIndex, captureIndices: [] });
  selectedHandIndex = null;
  selectedTableIndices.clear();
  updateThrowButton(false);
});

document.getElementById('btn-confirm-capture').addEventListener('click', () => {
  if (selectedHandIndex === null || selectedTableIndices.size === 0) return;
  socket.emit('play_card', {
    code: myCode,
    cardIndex: selectedHandIndex,
    captureIndices: [...selectedTableIndices],
  });
  selectedHandIndex = null;
  selectedTableIndices.clear();
  document.getElementById('capture-bar').classList.add('hidden');
});

document.getElementById('btn-cancel-capture').addEventListener('click', () => {
  selectedHandIndex = null;
  selectedTableIndices.clear();
  document.getElementById('capture-bar').classList.add('hidden');
  if (gameState) renderGame(gameState);
});

// Client-side capture finder (mirrors server logic)
function findCaptures(cardValue, table) {
  const results = [];
  const n = table.length;
  for (let mask = 1; mask < (1 << n); mask++) {
    let sum = 0;
    const combo = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) { sum += table[i].value; combo.push(i); }
    }
    if (sum === cardValue) results.push(combo);
  }
  return results;
}

/* ── Round End ───────────────────────────────────────────────────────── */
function renderRoundEnd(state) {
  showScreen('screen-round-end');
  const breakdown = state.roundScores;
  if (!breakdown) return;

  // Table
  const bdDiv = document.getElementById('round-breakdown');
  const isTeams = state.teams !== null;

  // Helper: wrap in bold if this is the winner of a column
  const b = (val, isBold) => isBold ? `<strong>${val}</strong>` : val;

  if (isTeams) {
    const teams = [0, 1].map(t => {
      const members = breakdown.filter(b => b.teamIndex === t);
      const agg = members[0].teamAgg;
      const pts = members[0].points;
      const tied = members.some(b => b.sevensTied);
      return { t, members, agg, pts, tied };
    });
    const sevensTied = teams.some(t => t.tied);
    // Determine column winners for bolding
    const maxCards = Math.max(...teams.map(t => t.agg.totalCards));
    const maxDiamonds = Math.max(...teams.map(t => t.agg.diamonds));
    const maxSevens = Math.max(...teams.map(t => t.agg.sevens));
    const maxSixes = Math.max(...teams.map(t => t.agg.sixes));
    const cardWin = teams.filter(t => t.agg.totalCards === maxCards).length === 1;
    const diaWin  = teams.filter(t => t.agg.diamonds === maxDiamonds).length === 1;
    const sevWin  = teams.filter(t => t.agg.sevens === maxSevens).length === 1;
    const sixWin  = teams.filter(t => t.agg.sixes === maxSixes).length === 1 && sevensTied;

    const cols = ['Team', 'Cards', '♦', '7♦', 'Sevens', ...(sevensTied ? ['Sixes'] : []), 'Scopas', 'Pts'];
    let html = '<table><thead><tr>' + cols.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>';
    for (const { t, members, agg, pts, tied } of teams) {
      const maxScopas = Math.max(...teams.map(t2 => t2.agg.scopas));
      const label = `Team ${t === 0 ? 'A' : 'B'}<br><small>${members.map(b2 => b2.name).join(' & ')}</small>`;
      html += `<tr class="team-row-${t}">
        <td>${label}</td>
        <td>${b(agg.totalCards, cardWin && agg.totalCards === maxCards)}</td>
        <td>${b(agg.diamonds, diaWin && agg.diamonds === maxDiamonds)}</td>
        <td>${b(agg.hasSettebello ? '✓' : '', agg.hasSettebello)}</td>
        <td>${b(agg.sevens + (tied ? ' *' : ''), sevWin && agg.sevens === maxSevens)}</td>
        ${sevensTied ? `<td>${tied ? b(agg.sixes, sixWin && agg.sixes === maxSixes) : '–'}</td>` : ''}
        <td>${b(agg.scopas, agg.scopas === maxScopas && maxScopas > 0)}</td>
        <td class="earned">+${pts}</td>
      </tr>`;
    }
    if (sevensTied) html += `<tr><td colspan="${cols.length}" class="tie-note">* Tied on 7s — tiebreak by 6s</td></tr>`;
    html += '</tbody></table>';
    bdDiv.innerHTML = html;
  } else {
    const sevensTied = breakdown.some(b2 => b2.sevensTied);
    const maxCards    = Math.max(...breakdown.map(b2 => b2.totalCards));
    const maxDiamonds = Math.max(...breakdown.map(b2 => b2.diamonds));
    const maxSevens   = Math.max(...breakdown.map(b2 => b2.sevens));
    const maxSixes    = Math.max(...breakdown.map(b2 => b2.sixes));
    const maxScopas   = Math.max(...breakdown.map(b2 => b2.scopas));
    const cardWin  = breakdown.filter(b2 => b2.totalCards === maxCards).length === 1;
    const diaWin   = breakdown.filter(b2 => b2.diamonds === maxDiamonds).length === 1;
    const sevWin   = breakdown.filter(b2 => b2.sevens === maxSevens).length === 1;
    const sixWin   = breakdown.filter(b2 => b2.sixes === maxSixes).length === 1 && sevensTied;

    const cols = ['Player', 'Cards', '♦', '7♦', 'Sevens', ...(sevensTied ? ['Sixes'] : []), 'Scopas', 'Pts'];
    let html = '<table><thead><tr>' + cols.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>';
    for (const b2 of breakdown) {
      html += `<tr>
        <td>${b2.name}</td>
        <td>${b(b2.totalCards, cardWin && b2.totalCards === maxCards)}</td>
        <td>${b(b2.diamonds, diaWin && b2.diamonds === maxDiamonds)}</td>
        <td>${b(b2.hasSettebello ? '✓' : '', b2.hasSettebello)}</td>
        <td>${b(b2.sevens + (b2.sevensTied ? ' *' : ''), sevWin && b2.sevens === maxSevens)}</td>
        ${sevensTied ? `<td>${b2.sevensTied ? b(b2.sixes, sixWin && b2.sixes === maxSixes) : '–'}</td>` : ''}
        <td>${b(b2.scopas, b2.scopas === maxScopas && maxScopas > 0)}</td>
        <td class="earned">+${b2.points}</td>
      </tr>`;
    }
    if (sevensTied) html += `<tr><td colspan="${cols.length}" class="tie-note">* Tied on 7s — tiebreak by 6s</td></tr>`;
    html += '</tbody></table>';
    bdDiv.innerHTML = html;
  }

  // Totals
  const totDiv = document.getElementById('total-scores');
  totDiv.innerHTML = '';
  if (state.teams) {
    [0, 1].forEach(t => {
      const members = state.players.filter(p => p.teamIndex === t);
      const teamScore = members[0].score; // shared, same for both
      const row = document.createElement('div');
      row.className = `total-row team-${t}`;
      row.innerHTML = `<span class="total-row-name">Team ${t === 0 ? 'A' : 'B'}: ${members.map(p => p.name).join(' & ')}</span><span class="total-row-score">${teamScore}</span>`;
      totDiv.appendChild(row);
    });
  } else {
    const sorted = [...state.players].sort((a, b) => b.score - a.score);
    for (const p of sorted) {
      const row = document.createElement('div');
      row.className = 'total-row';
      row.innerHTML = `<span class="total-row-name">${p.name}</span><span class="total-row-score">${p.score}</span>`;
      totDiv.appendChild(row);
    }
  }

  const nextBtn = document.getElementById('btn-next-round');
  const isHost = state.players[state.myIndex]?.isHost;
  if (isHost) nextBtn.classList.remove('hidden');
  else nextBtn.classList.add('hidden');
}

document.getElementById('btn-next-round').addEventListener('click', () => {
  socket.emit('next_round', { code: myCode });
});

/* ── Game End ────────────────────────────────────────────────────────── */
function renderGameEnd(state) {
  showScreen('screen-game-end');

  const finalDiv = document.getElementById('final-scores');
  finalDiv.innerHTML = '';

  if (state.teams) {
    const teamScores = [0, 1].map(t => ({
      t, score: state.players.filter(p => p.teamIndex === t)[0].score,
      names: state.players.filter(p => p.teamIndex === t).map(p => p.name).join(' & '),
    })).sort((a, b) => b.score - a.score);
    document.getElementById('winner-name').textContent = `Team ${teamScores[0].t === 0 ? 'A' : 'B'}`;
    for (const ts of teamScores) {
      const row = document.createElement('div');
      row.className = `total-row team-${ts.t}`;
      row.innerHTML = `<span class="total-row-name">Team ${ts.t === 0 ? 'A' : 'B'}: ${ts.names}</span><span class="total-row-score">${ts.score}</span>`;
      finalDiv.appendChild(row);
    }
  } else {
    const sorted = [...state.players].sort((a, b) => b.score - a.score);
    document.getElementById('winner-name').textContent = sorted[0].name;
    for (const p of sorted) {
      const row = document.createElement('div');
      row.className = 'total-row';
      row.innerHTML = `<span class="total-row-name">${p.name}</span><span class="total-row-score">${p.score}</span>`;
      finalDiv.appendChild(row);
    }
  }
}

/* ── Initial screen ─────────────────────────────────────────────────── */
showScreen('screen-lobby');

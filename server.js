const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ─── Game State Store ────────────────────────────────────────────────────────
const rooms = {};

// ─── Card Utilities ──────────────────────────────────────────────────────────
const SUITS = ['coins', 'cups', 'swords', 'clubs'];
const VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

function makeDeck() {
  const deck = [];
  for (const suit of SUITS)
    for (const value of VALUES)
      deck.push({ suit, value });
  return deck;
}

function shuffleDeck(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function cutDeck(deck) {
  const mid = Math.floor(deck.length / 2);
  const variance = Math.floor(deck.length * 0.25);
  const cutPoint = mid - variance + Math.floor(Math.random() * variance * 2);
  return [...deck.slice(cutPoint), ...deck.slice(0, cutPoint)];
}

function findCaptures(cardValue, table) {
  const results = [];
  const n = table.length;
  for (let mask = 1; mask < (1 << n); mask++) {
    let sum = 0; const combo = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) { sum += table[i].value; combo.push(i); }
    }
    if (sum === cardValue) results.push(combo);
  }
  return results;
}

// ─── Room Code ───────────────────────────────────────────────────────────────
function generateRoomCode() {
  let code;
  do { code = Math.floor(1000 + Math.random() * 9000).toString(); } while (rooms[code]);
  return code;
}

// ─── Room Creation ───────────────────────────────────────────────────────────
function createRoom(hostSocketId, hostName) {
  const code = generateRoomCode();
  rooms[code] = {
    code, phase: 'lobby',
    players: [{ id: hostSocketId, name: hostName, isHost: true, isBot: false,
      score: 0, hand: [], captured: [], scopas: 0, teamIndex: 0 }],
    teams: null,       // null = free-for-all, [[0,2],[1,3]] = 2v2
    table: [], deck: [],
    dealerIndex: null, currentPlayerIndex: null, lastCapturePlayerIndex: null,
    roundScores: [], dealtThisRound: 0, isLastDeal: false, busy: false,
  };
  return code;
}

function getRoom(code) { return rooms[code]; }

// ─── Player View ─────────────────────────────────────────────────────────────
function buildPlayerView(room, socketId) {
  const myIndex = room.players.findIndex(p => p.id === socketId);
  return {
    code: room.code,
    phase: room.phase,
    myIndex,
    players: room.players.map((p, i) => ({
      name: p.name, score: p.score,
      capturedCount: p.captured.length,
      scopas: p.scopas,
      isDealer: i === room.dealerIndex,
      isCurrentTurn: i === room.currentPlayerIndex,
      handCount: p.hand.length,
      hand: i === myIndex ? p.hand : null,
      isHost: p.isHost || false,
      isBot: p.isBot || false,
      teamIndex: p.teamIndex ?? null,
    })),
    teams: room.teams,
    table: room.table,
    dealerIndex: room.dealerIndex,
    currentPlayerIndex: room.currentPlayerIndex,
    deckCount: room.deck.length,
    pendingShuffle: room.pendingShuffle,
    pendingCut: room.pendingCut,
    isLastDeal: room.isLastDeal || false,
    lastCapturePlayerIndex: room.lastCapturePlayerIndex,
    roundScores: (room.phase === 'round_end' || room.phase === 'game_end') ? room.roundScores : null,
  };
}

function broadcastRoom(code) {
  const room = getRoom(code);
  if (!room) return;
  for (const player of room.players) {
    const socket = io.sockets.sockets.get(player.id);
    if (!socket) continue;
    socket.emit('game_state', buildPlayerView(room, player.id));
  }
}

// ─── Round Setup ─────────────────────────────────────────────────────────────
function startNewRound(room) {
  for (const p of room.players) { p.hand = []; p.captured = []; p.scopas = 0; }
  room.table = [];
  room.deck = makeDeck();
  room.lastCapturePlayerIndex = null;
  room.dealtThisRound = 0;
  room.isLastDeal = false;
  room.busy = false;

  if (room.dealerIndex === null)
    room.dealerIndex = Math.floor(Math.random() * room.players.length);
  else
    room.dealerIndex = (room.dealerIndex + 1) % room.players.length;

  room.pendingShuffle = true;
  room.pendingCut = false;
  room.phase = 'shuffle';

  // Auto-handle if dealer is bot
  if (room.players[room.dealerIndex].isBot) {
    room.deck = shuffleDeck(room.deck);
    room.pendingShuffle = false;
    const n = room.players.length;
    const cutterIndex = (room.dealerIndex - 1 + n) % n;
    if (room.players[cutterIndex].isBot) {
      room.deck = cutDeck(room.deck);
      room.pendingCut = false;
      dealCards(room);
    } else {
      room.pendingCut = true;
      room.phase = 'cut';
    }
  }
}

function dealCards(room) {
  if (room.dealtThisRound === 0) {
    for (let i = 0; i < 4; i++) room.table.push(room.deck.pop());
  }
  for (const player of room.players) {
    for (let i = 0; i < 3; i++)
      if (room.deck.length > 0) player.hand.push(room.deck.pop());
  }
  room.dealtThisRound++;
  room.isLastDeal = room.deck.length === 0;
  room.currentPlayerIndex = (room.dealerIndex + 1) % room.players.length;
  room.phase = 'playing';
  io.to(room.code).emit('cards_dealt', { isLastDeal: room.isLastDeal });
}

// ─── Scoring ─────────────────────────────────────────────────────────────────
function computeRoundScores(room) {
  const players = room.players;
  const n = players.length;
  const isTeams = room.teams !== null;

  // Build per-player stats
  const stats = players.map((p, i) => ({
    playerIndex: i, name: p.name,
    scopas: p.scopas,
    totalCards: p.captured.length,
    diamonds: p.captured.filter(c => c.suit === 'coins').length,
    sevens: p.captured.filter(c => c.value === 7).length,
    sixes: p.captured.filter(c => c.value === 6).length,
    hasSettebello: p.captured.some(c => c.suit === 'coins' && c.value === 7),
    points: p.scopas,
    sevensTied: false,
    teamIndex: p.teamIndex ?? i,
  }));

  // In team mode, aggregate per-team for scoring purposes
  const getTeamStats = (teamIdx) => {
    const members = stats.filter(s => s.teamIndex === teamIdx);
    return {
      totalCards: members.reduce((a, b) => a + b.totalCards, 0),
      diamonds:   members.reduce((a, b) => a + b.diamonds, 0),
      sevens:     members.reduce((a, b) => a + b.sevens, 0),
      sixes:      members.reduce((a, b) => a + b.sixes, 0),
      hasSettebello: members.some(b => b.hasSettebello),
      scopas:     members.reduce((a, b) => a + b.scopas, 0),
    };
  };

  if (isTeams) {
    const teamIndices = [...new Set(players.map(p => p.teamIndex))];
    const teamStats = Object.fromEntries(teamIndices.map(t => [t, getTeamStats(t)]));

    // Start each player's points with their team's combined scopas
    for (const s of stats) s.points = teamStats[s.teamIndex].scopas;

    // Carte
    const maxCards = Math.max(...teamIndices.map(t => teamStats[t].totalCards));
    const cardWinners = teamIndices.filter(t => teamStats[t].totalCards === maxCards);
    if (cardWinners.length === 1)
      stats.filter(s => s.teamIndex === cardWinners[0]).forEach(s => s.points++);

    // Diamonds
    const maxDiamonds = Math.max(...teamIndices.map(t => teamStats[t].diamonds));
    const diamondWinners = teamIndices.filter(t => teamStats[t].diamonds === maxDiamonds);
    if (diamondWinners.length === 1)
      stats.filter(s => s.teamIndex === diamondWinners[0]).forEach(s => s.points++);

    // Settebello
    const settebelloTeam = teamIndices.find(t => teamStats[t].hasSettebello);
    if (settebelloTeam !== undefined)
      stats.filter(s => s.teamIndex === settebelloTeam).forEach(s => s.points++);

    // Sevens
    const maxSevens = Math.max(...teamIndices.map(t => teamStats[t].sevens));
    const sevenTiedTeams = teamIndices.filter(t => teamStats[t].sevens === maxSevens);
    if (sevenTiedTeams.length === 1) {
      stats.filter(s => s.teamIndex === sevenTiedTeams[0]).forEach(s => s.points++);
    } else {
      sevenTiedTeams.forEach(t => stats.filter(s => s.teamIndex === t).forEach(s => s.sevensTied = true));
      const maxSixes = Math.max(...sevenTiedTeams.map(t => teamStats[t].sixes));
      const sixWinnerTeams = sevenTiedTeams.filter(t => teamStats[t].sixes === maxSixes);
      if (sixWinnerTeams.length === 1)
        stats.filter(s => s.teamIndex === sixWinnerTeams[0]).forEach(s => s.points++);
    }

    // Attach aggregated team stats to each player's breakdown entry for display
    for (const s of stats) s.teamAgg = teamStats[s.teamIndex];

    // Apply points to actual player scores (same for both teammates)
    for (const s of stats) players[s.playerIndex].score += s.points;

  } else {
    // Free-for-all
    const maxCards = Math.max(...stats.map(s => s.totalCards));
    const cardWinners = stats.filter(s => s.totalCards === maxCards);
    if (cardWinners.length === 1) cardWinners[0].points++;

    const maxDiamonds = Math.max(...stats.map(s => s.diamonds));
    const diamondWinners = stats.filter(s => s.diamonds === maxDiamonds);
    if (diamondWinners.length === 1) diamondWinners[0].points++;

    const settebello = stats.find(s => s.hasSettebello);
    if (settebello) settebello.points++;

    const maxSevens = Math.max(...stats.map(s => s.sevens));
    const sevenTied = stats.filter(s => s.sevens === maxSevens);
    if (sevenTied.length === 1) {
      sevenTied[0].points++;
    } else {
      sevenTied.forEach(s => s.sevensTied = true);
      const maxSixes = Math.max(...sevenTied.map(s => s.sixes));
      const sixWinners = sevenTied.filter(s => s.sixes === maxSixes);
      if (sixWinners.length === 1) sixWinners[0].points++;
    }

    for (const s of stats) players[s.playerIndex].score += s.points;
  }

  return stats;
}

function checkGameOver(room) {
  const scores = room.players.map(p => p.score).sort((a, b) => b - a);
  const leader = scores[0];
  if (leader < 21) return false;
  return (leader - (scores[1] ?? 0)) >= 2;
}

// ─── Turn Advancement ─────────────────────────────────────────────────────────
function advanceTurn(room, code) {
  const allHandsEmpty = room.players.every(p => p.hand.length === 0);
  if (allHandsEmpty) {
    if (room.deck.length > 0) { dealCards(room); return; }
    // Show last-capture animation if there are table cards to collect
    if (room.lastCapturePlayerIndex !== null && room.table.length > 0) {
      const lastPlayer = room.players[room.lastCapturePlayerIndex];
      const remainingCards = [...room.table];
      lastPlayer.captured.push(...remainingCards);
      room.table = [];
      // Emit as a capture so everyone sees who collects the remaining cards
      io.to(code).emit('play_result', {
        playerName: lastPlayer.name,
        playedCard: null,
        capturedCards: remainingCards,
        isScopa: false,
        isTrail: false,
        isLastCapture: true,
      });
      room.busy = true;
      setTimeout(() => {
        room.busy = false;
        room.roundScores = computeRoundScores(room);
        room.phase = checkGameOver(room) ? 'game_end' : 'round_end';
        broadcastRoom(code);
      }, 2500);
      return;
    }
    room.roundScores = computeRoundScores(room);
    room.phase = checkGameOver(room) ? 'game_end' : 'round_end';
    return;
  }
  const n = room.players.length;
  let next = (room.currentPlayerIndex + 1) % n;
  let tries = 0;
  while (room.players[next].hand.length === 0 && tries < n) { next = (next + 1) % n; tries++; }
  room.currentPlayerIndex = next;
  if (room.players[next].isBot) {
    scheduleBotWatchdog(room, code, room.players[next].id);
  }
}

// ─── Bot AI ───────────────────────────────────────────────────────────────────
function botPlayTurn(room, code) {
  if (room.phase !== 'playing') return;
  if (room.busy) return; // will be re-triggered when busy clears

  const botIndex = room.currentPlayerIndex;
  const bot = room.players[botIndex];
  if (!bot || !bot.isBot) return;
  if (bot.hand.length === 0) { advanceTurn(room, code); broadcastRoom(code); return; }

  const table = room.table;
  let played = false;

  for (let ci = 0; ci < bot.hand.length; ci++) {
    const card = bot.hand[ci];
    const directIdx = table.findIndex(t => t.value === card.value);
    if (directIdx !== -1) { executeCapture(room, botIndex, ci, [directIdx]); played = true; break; }
    const captures = findCaptures(card.value, table);
    if (captures.length > 0) {
      const chosen = captures.find(c => c.length === table.length) || captures[0];
      executeCapture(room, botIndex, ci, chosen);
      played = true; break;
    }
  }

  if (!played) {
    const sorted = bot.hand.map((c, i) => ({ c, i })).sort((a, b) => a.c.value - b.c.value);
    const { c: trailCard, i: trailIdx } = sorted[0];
    bot.hand.splice(trailIdx, 1);
    room.table.push(trailCard);
    io.to(code).emit('play_result', {
      playerName: bot.name, playedCard: trailCard,
      capturedCards: [], isScopa: false, isTrail: true,
    });
    broadcastRoom(code);
    room.busy = true;
    setTimeout(() => {
      room.busy = false;
      advanceTurn(room, code);
      broadcastRoom(code);
      triggerBotIfNeeded(room, code);
    }, 2000);
  }
}

function executeCapture(room, playerIndex, cardIndex, captureIndices) {
  const player = room.players[playerIndex];
  const card = player.hand[cardIndex];
  const capturedCards = captureIndices.map(i => room.table[i]);
  player.captured.push(card, ...capturedCards);
  player.hand.splice(cardIndex, 1);
  room.table = room.table.filter((_, i) => !captureIndices.includes(i));
  room.lastCapturePlayerIndex = playerIndex;

  const isLastPlay = room.deck.length === 0 && room.players.every(p => p.hand.length === 0);
  let isScopa = false;
  if (room.table.length === 0 && !isLastPlay) {
    player.scopas++;
    isScopa = true;
    io.to(room.code).emit('scopa_announce', { playerName: player.name });
  }
  io.to(room.code).emit('play_result', {
    playerName: player.name, playedCard: card, capturedCards, isScopa, isTrail: false,
  });
  broadcastRoom(room.code);
  room.busy = true;
  setTimeout(() => {
    room.busy = false;
    advanceTurn(room, room.code);
    broadcastRoom(room.code);
    triggerBotIfNeeded(room, room.code);
  }, 2500);
}

function triggerBotIfNeeded(room, code) {
  if (room.phase !== 'playing') return;
  const cur = room.players[room.currentPlayerIndex];
  if (!cur || !cur.isBot) return;
  // Use a watchdog: poll until not busy, then fire
  scheduleBotWatchdog(room, code, cur.id);
}

function scheduleBotWatchdog(room, code, botId) {
  // Delay before first attempt (let animation finish)
  setTimeout(() => runBotWatchdog(room, code, botId, 0), 1200);
}

function runBotWatchdog(room, code, botId, attempts) {
  if (room.phase !== 'playing') return;
  // Make sure the expected bot is still the current player
  const cur = room.players[room.currentPlayerIndex];
  if (!cur || cur.id !== botId) return; // turn moved on, nothing to do
  if (room.busy) {
    // Still busy — retry in 400ms, up to 20 attempts (~8s total)
    if (attempts < 20) setTimeout(() => runBotWatchdog(room, code, botId, attempts + 1), 400);
    return;
  }
  botPlayTurn(room, code);
}

// ─── Socket Handlers ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('create_room', ({ name }) => {
    const code = createRoom(socket.id, name);
    socket.join(code);
    socket.emit('room_created', { code });
    broadcastRoom(code);
  });

  socket.on('join_room', ({ code, name }) => {
    const room = getRoom(code);
    if (!room) return socket.emit('error', { message: 'Room not found' });
    if (room.phase !== 'lobby') return socket.emit('error', { message: 'Game already started' });
    if (room.players.length >= 4) return socket.emit('error', { message: 'Room is full' });
    if (room.players.find(p => p.name.toLowerCase() === name.toLowerCase()))
      return socket.emit('error', { message: 'Name already taken' });
    room.players.push({ id: socket.id, name, isHost: false, isBot: false,
      score: 0, hand: [], captured: [], scopas: 0, teamIndex: room.players.length });
    socket.join(code);
    socket.emit('room_joined', { code });
    broadcastRoom(code);
  });

  socket.on('add_bot', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'lobby') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isHost) return;
    if (room.players.length >= 4) return socket.emit('error', { message: 'Room is full' });
    const botNames = ['Bot Avi', 'Bot Bina', 'Bot Gal'];
    const used = room.players.map(p => p.name);
    const botName = botNames.find(n => !used.includes(n)) || `Bot ${room.players.length}`;
    room.players.push({ id: `bot_${Date.now()}`, name: botName, isHost: false, isBot: true,
      score: 0, hand: [], captured: [], scopas: 0, teamIndex: room.players.length });
    broadcastRoom(code);
  });

  socket.on('remove_bot', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'lobby') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isHost) return;
    const lastBotIdx = [...room.players].reverse().findIndex(p => p.isBot);
    if (lastBotIdx === -1) return;
    room.players.splice(room.players.length - 1 - lastBotIdx, 1);
    broadcastRoom(code);
  });

  // Host assigns teams: teamAssignments = [0,1,0,1] (index = player slot, value = team 0 or 1)
  socket.on('set_teams', ({ code, teamAssignments }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'lobby') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isHost) return;
    if (room.players.length !== 4) return;
    // teamAssignments: array of length 4 with values 0 or 1
    // Arrange seating so partners sit across: team0 gets seats 0,2; team1 gets seats 1,3
    const team0 = teamAssignments.map((t, i) => ({ t, i })).filter(x => x.t === 0).map(x => x.i);
    const team1 = teamAssignments.map((t, i) => ({ t, i })).filter(x => x.t === 1).map(x => x.i);
    if (team0.length !== 2 || team1.length !== 2) return socket.emit('error', { message: 'Each team needs exactly 2 players' });
    // Reorder players: seat0=team0[0], seat1=team1[0], seat2=team0[1], seat3=team1[1]
    const ordered = [
      room.players[team0[0]], room.players[team1[0]],
      room.players[team0[1]], room.players[team1[1]],
    ];
    ordered[0].teamIndex = 0; ordered[2].teamIndex = 0;
    ordered[1].teamIndex = 1; ordered[3].teamIndex = 1;
    room.players = ordered;
    room.teams = [[0, 2], [1, 3]]; // seat indices per team
    broadcastRoom(code);
  });

  socket.on('clear_teams', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'lobby') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isHost) return;
    room.teams = null;
    room.players.forEach((p, i) => p.teamIndex = i);
    broadcastRoom(code);
  });

  socket.on('start_game', ({ code }) => {
    const room = getRoom(code);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isHost) return;
    if (room.players.length < 2) return socket.emit('error', { message: 'Need at least 2 players' });
    if (room.players.length === 4 && room.teams === null)
      return socket.emit('error', { message: 'Please assign teams before starting' });
    startNewRound(room);
    broadcastRoom(code);
  });

  socket.on('shuffle_done', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'shuffle') return;
    if (room.players[room.dealerIndex].id !== socket.id) return;
    room.deck = shuffleDeck(room.deck);
    room.pendingShuffle = false;
    room.pendingCut = true;
    room.phase = 'cut';
    const n = room.players.length;
    const cutterIndex = (room.dealerIndex - 1 + n) % n;
    if (room.players[cutterIndex].isBot) {
      room.deck = cutDeck(room.deck);
      room.pendingCut = false;
      dealCards(room);
      triggerBotIfNeeded(room, code);
    }
    broadcastRoom(code);
  });

  socket.on('cut_done', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'cut') return;
    const n = room.players.length;
    const cutterIndex = (room.dealerIndex - 1 + n) % n;
    if (room.players[cutterIndex].id !== socket.id) return;
    room.deck = cutDeck(room.deck);
    room.pendingCut = false;
    dealCards(room);
    triggerBotIfNeeded(room, code);
    broadcastRoom(code);
  });

  socket.on('play_card', ({ code, cardIndex, captureIndices }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'playing') return;
    if (room.busy) return;
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== room.currentPlayerIndex) return;
    const player = room.players[playerIndex];
    if (cardIndex < 0 || cardIndex >= player.hand.length) return;
    const card = player.hand[cardIndex];
    const table = room.table;
    const possibleCaptures = findCaptures(card.value, table);
    const mustCapture = possibleCaptures.length > 0;

    if (mustCapture) {
      const directMatchIndex = table.findIndex(t => t.value === card.value);
      if (directMatchIndex !== -1) {
        captureIndices = [directMatchIndex];
      } else {
        if (!captureIndices || captureIndices.length === 0) captureIndices = possibleCaptures[0];
        const isValid = possibleCaptures.some(combo =>
          combo.length === captureIndices.length && combo.every(i => captureIndices.includes(i)));
        if (!isValid) return socket.emit('error', { message: 'Invalid capture selection' });
      }
      const capturedCards = captureIndices.map(i => table[i]);
      player.captured.push(card, ...capturedCards);
      player.hand.splice(cardIndex, 1);
      room.table = table.filter((_, i) => !captureIndices.includes(i));
      room.lastCapturePlayerIndex = playerIndex;

      const isLastPlay = room.table.length === 0 && room.deck.length === 0 &&
        room.players.every(p => p.hand.length === 0);
      let isScopa = false;
      if (room.table.length === 0 && !isLastPlay) {
        player.scopas++; isScopa = true;
        io.to(code).emit('scopa_announce', { playerName: player.name });
      }
      room.busy = true;
      io.to(code).emit('play_result', { playerName: player.name, playedCard: card, capturedCards, isScopa, isTrail: false });
      setTimeout(() => {
        room.busy = false;
        advanceTurn(room, code);
        broadcastRoom(code);
        triggerBotIfNeeded(room, code);
      }, 2500);
    } else {
      player.hand.splice(cardIndex, 1);
      room.table.push(card);
      room.busy = true;
      io.to(code).emit('play_result', { playerName: player.name, playedCard: card, capturedCards: [], isScopa: false, isTrail: true });
      setTimeout(() => {
        room.busy = false;
        advanceTurn(room, code);
        broadcastRoom(code);
        triggerBotIfNeeded(room, code);
      }, 2000);
    }
  });

  socket.on('next_round', ({ code }) => {
    const room = getRoom(code);
    if (!room || room.phase !== 'round_end') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player?.isHost) return;
    room.phase = checkGameOver(room) ? 'game_end' : 'lobby_ignored';
    startNewRound(room);
    broadcastRoom(code);
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        const leavingPlayer = room.players[idx];
        const name = leavingPlayer.name;
        io.to(code).emit('player_left', { name });

        if (room.phase !== 'lobby' && room.teams !== null) {
          // Team game in progress: replace with a bot keeping the same seat & team
          const botNames = ['Bot Avi', 'Bot Bina', 'Bot Gal', 'Bot Dan'];
          const used = room.players.map(p => p.name);
          const botName = botNames.find(n => !used.includes(n)) || `Bot ${idx}`;
          room.players[idx] = {
            id: `bot_${Date.now()}`,
            name: botName,
            isHost: leavingPlayer.isHost,
            isBot: true,
            score: leavingPlayer.score,
            hand: leavingPlayer.hand,
            captured: leavingPlayer.captured,
            scopas: leavingPlayer.scopas,
            teamIndex: leavingPlayer.teamIndex,
          };
          // Transfer host if needed
          if (leavingPlayer.isHost) {
            const nextHuman = room.players.find(p => !p.isBot);
            if (nextHuman) { nextHuman.isHost = true; room.players[idx].isHost = false; }
          }
          io.to(code).emit('player_replaced', { name, botName });
          // If it's the bot's turn now, trigger it
          if (room.phase === 'playing' && room.currentPlayerIndex === idx && !room.busy) {
            setTimeout(() => botPlayTurn(room, code), 1200);
          }
        } else {
          room.players.splice(idx, 1);
          if (room.players.length === 0) { delete rooms[code]; return; }
          if (!room.players.find(p => p.isHost)) room.players[0].isHost = true;
          // End game if only one human left
          const humanPlayers = room.players.filter(p => !p.isBot);
          if (room.phase !== 'lobby' && humanPlayers.length <= 1) room.phase = 'game_end';
        }

        broadcastRoom(code);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Scopa server running on http://0.0.0.0:${PORT}`));

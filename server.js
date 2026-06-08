const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const SUITS = ['coins', 'cups', 'swords', 'clubs'];
const VALUES = [1,2,3,4,5,6,7,8,9,10];

function log(code, msg) {
  const room = rooms[code];
  const ts = new Date().toISOString().slice(11,23);
  const phase = room ? room.phase : '?';
  const cur = room ? (room.players[room.currentPlayerIndex]?.name || '?') : '?';
  const busy = room ? room.busy : '?';
  console.log(`[${ts}] [${code}] [${phase}] [turn:${cur}] [busy:${busy}] ${msg}`);
}

// ─── Card Utils ───────────────────────────────────────────────────────────────
function makeDeck() {
  return SUITS.flatMap(suit => VALUES.map(value => ({ suit, value })));
}
function shuffleDeck(deck) {
  const d = [...deck];
  for (let i = d.length-1; i > 0; i--) { const j = Math.floor(Math.random()*(i+1)); [d[i],d[j]]=[d[j],d[i]]; }
  return d;
}
function cutDeck(deck) {
  const mid = Math.floor(deck.length/2), v = Math.floor(deck.length*0.25);
  const cp = mid - v + Math.floor(Math.random()*v*2);
  return [...deck.slice(cp), ...deck.slice(0,cp)];
}
function findCaptures(cardValue, table) {
  const results = [];
  for (let mask=1; mask<(1<<table.length); mask++) {
    let sum=0; const combo=[];
    for (let i=0; i<table.length; i++) if (mask&(1<<i)) { sum+=table[i].value; combo.push(i); }
    if (sum===cardValue) results.push(combo);
  }
  return results;
}
function cardStr(c) { return c ? `${c.value}${c.suit[0]}` : '?'; }

// ─── Room ─────────────────────────────────────────────────────────────────────
function generateCode() {
  let code; do { code = Math.floor(1000+Math.random()*9000).toString(); } while (rooms[code]);
  return code;
}
function createRoom(hostId, hostName) {
  const code = generateCode();
  rooms[code] = {
    code, phase:'lobby',
    players:[{id:hostId,name:hostName,isHost:true,isBot:false,score:0,hand:[],captured:[],scopas:0,teamIndex:0}],
    teams:null, table:[], deck:[],
    dealerIndex:null, currentPlayerIndex:null, lastCapturePlayerIndex:null,
    roundScores:[], dealtThisRound:0, isLastDeal:false,
    busy:false, busySetAt:0,
  };
  return code;
}
function getRoom(code) { return rooms[code]; }

// ─── View ─────────────────────────────────────────────────────────────────────
function buildView(room, socketId) {
  const myIndex = room.players.findIndex(p => p.id === socketId);
  return {
    code:room.code, phase:room.phase, myIndex,
    players: room.players.map((p,i) => ({
      name:p.name, score:p.score, capturedCount:p.captured.length,
      scopas:p.scopas, isDealer:i===room.dealerIndex,
      isCurrentTurn:i===room.currentPlayerIndex,
      handCount:p.hand.length, hand:i===myIndex?p.hand:null,
      isHost:p.isHost||false, isBot:p.isBot||false, teamIndex:p.teamIndex??null,
    })),
    teams:room.teams, table:room.table,
    dealerIndex:room.dealerIndex, currentPlayerIndex:room.currentPlayerIndex,
    deckCount:room.deck.length,
    pendingShuffle:room.pendingShuffle, pendingCut:room.pendingCut,
    isLastDeal:room.isLastDeal||false,
    lastCapturePlayerIndex:room.lastCapturePlayerIndex,
    roundScores:(['round_end','game_end'].includes(room.phase))?room.roundScores:null,
  };
}
function broadcast(code) {
  const room = getRoom(code); if (!room) return;
  for (const p of room.players) {
    const s = io.sockets.sockets.get(p.id);
    if (s) s.emit('game_state', buildView(room, p.id));
  }
}

// ─── Busy ─────────────────────────────────────────────────────────────────────
function setBusy(room, val) {
  room.busy = val;
  room.busySetAt = val ? Date.now() : 0;
  if (val) log(room.code, `busy=true`);
  else log(room.code, `busy=false`);
}

// ─── Round ────────────────────────────────────────────────────────────────────
function startNewRound(room) {
  for (const p of room.players) { p.hand=[]; p.captured=[]; p.scopas=0; }
  room.table=[]; room.deck=makeDeck();
  room.lastCapturePlayerIndex=null; room.dealtThisRound=0; room.isLastDeal=false;
  setBusy(room, false);
  room.dealerIndex = room.dealerIndex===null
    ? Math.floor(Math.random()*room.players.length)
    : (room.dealerIndex+1)%room.players.length;
  room.pendingShuffle=true; room.pendingCut=false; room.phase='shuffle';
  log(room.code, `new round, dealer=${room.players[room.dealerIndex].name}`);

  if (room.players[room.dealerIndex].isBot) {
    room.deck=shuffleDeck(room.deck); room.pendingShuffle=false;
    const cutterIndex=(room.dealerIndex-1+room.players.length)%room.players.length;
    if (room.players[cutterIndex].isBot) {
      room.deck=cutDeck(room.deck); room.pendingCut=false; dealCards(room);
    } else { room.pendingCut=true; room.phase='cut'; }
  }
}

function dealCards(room) {
  if (room.dealtThisRound===0) for (let i=0;i<4;i++) room.table.push(room.deck.pop());
  for (const p of room.players) for (let i=0;i<3;i++) if (room.deck.length>0) p.hand.push(room.deck.pop());
  room.dealtThisRound++;
  room.isLastDeal=room.deck.length===0;
  room.currentPlayerIndex=(room.dealerIndex+1)%room.players.length;
  room.phase='playing';
  log(room.code, `dealt set ${room.dealtThisRound}, deckLeft=${room.deck.length}, isLastDeal=${room.isLastDeal}, firstPlayer=${room.players[room.currentPlayerIndex]?.name}`);
  io.to(room.code).emit('cards_dealt',{isLastDeal:room.isLastDeal});
  // Always trigger bot here — handles both first deal and mid-round re-deals
  const first = room.players[room.currentPlayerIndex];
  if (first && first.isBot) scheduleBotWatchdog(room, room.code, first.id);
}

// ─── Scoring ─────────────────────────────────────────────────────────────────
function computeRoundScores(room) {
  const players=room.players, isTeams=room.teams!==null;
  const stats=players.map((p,i)=>({
    playerIndex:i, name:p.name, scopas:p.scopas,
    totalCards:p.captured.length, diamonds:p.captured.filter(c=>c.suit==='coins').length,
    sevens:p.captured.filter(c=>c.value===7).length, sixes:p.captured.filter(c=>c.value===6).length,
    hasSettebello:p.captured.some(c=>c.suit==='coins'&&c.value===7),
    points:p.scopas, sevensTied:false, teamIndex:p.teamIndex??i, teamAgg:null,
  }));

  const teamAgg=t=>{
    const m=stats.filter(s=>s.teamIndex===t);
    return { totalCards:m.reduce((a,b)=>a+b.totalCards,0), diamonds:m.reduce((a,b)=>a+b.diamonds,0),
      sevens:m.reduce((a,b)=>a+b.sevens,0), sixes:m.reduce((a,b)=>a+b.sixes,0),
      hasSettebello:m.some(b=>b.hasSettebello), scopas:m.reduce((a,b)=>a+b.scopas,0) };
  };

  if (isTeams) {
    const tIdxs=[...new Set(players.map(p=>p.teamIndex))];
    const ts=Object.fromEntries(tIdxs.map(t=>[t,teamAgg(t)]));
    for (const s of stats) { s.points=ts[s.teamIndex].scopas; s.teamAgg=ts[s.teamIndex]; }
    const award=(winnerTeam)=>stats.filter(s=>s.teamIndex===winnerTeam).forEach(s=>s.points++);
    const maxC=Math.max(...tIdxs.map(t=>ts[t].totalCards)); if(tIdxs.filter(t=>ts[t].totalCards===maxC).length===1) award(tIdxs.find(t=>ts[t].totalCards===maxC));
    const maxD=Math.max(...tIdxs.map(t=>ts[t].diamonds)); if(tIdxs.filter(t=>ts[t].diamonds===maxD).length===1) award(tIdxs.find(t=>ts[t].diamonds===maxD));
    const sbt=tIdxs.find(t=>ts[t].hasSettebello); if(sbt!==undefined) award(sbt);
    const maxS=Math.max(...tIdxs.map(t=>ts[t].sevens)); const sTied=tIdxs.filter(t=>ts[t].sevens===maxS);
    if(sTied.length===1){award(sTied[0]);}else{
      sTied.forEach(t=>stats.filter(s=>s.teamIndex===t).forEach(s=>s.sevensTied=true));
      const maxSix=Math.max(...sTied.map(t=>ts[t].sixes)); const sixW=sTied.filter(t=>ts[t].sixes===maxSix);
      if(sixW.length===1) award(sixW[0]);
    }
  } else {
    const award=(s)=>s.points++;
    const maxC=Math.max(...stats.map(s=>s.totalCards)); const cW=stats.filter(s=>s.totalCards===maxC); if(cW.length===1) award(cW[0]);
    const maxD=Math.max(...stats.map(s=>s.diamonds)); const dW=stats.filter(s=>s.diamonds===maxD); if(dW.length===1) award(dW[0]);
    const sb=stats.find(s=>s.hasSettebello); if(sb) award(sb);
    const maxS=Math.max(...stats.map(s=>s.sevens)); const sTied=stats.filter(s=>s.sevens===maxS);
    if(sTied.length===1){award(sTied[0]);}else{
      sTied.forEach(s=>s.sevensTied=true);
      const maxSix=Math.max(...sTied.map(s=>s.sixes)); const sixW=sTied.filter(s=>s.sixes===maxSix);
      if(sixW.length===1) award(sixW[0]);
    }
  }
  for (const s of stats) players[s.playerIndex].score+=s.points;
  log(room.code, `round scores: ${stats.map(s=>`${s.name}+${s.points}`).join(', ')}`);
  return stats;
}

function checkGameOver(room) {
  const scores=room.players.map(p=>p.score).sort((a,b)=>b-a);
  return scores[0]>=21 && (scores[0]-(scores[1]??0))>=2;
}

// ─── Turn Advancement ─────────────────────────────────────────────────────────
function advanceTurn(room, code) {
  log(code, `advanceTurn called`);
  const allEmpty=room.players.every(p=>p.hand.length===0);
  if (allEmpty) {
    if (room.deck.length>0) { log(code,'all hands empty, dealing'); dealCards(room); return; }
    if (room.lastCapturePlayerIndex!==null && room.table.length>0) {
      const lp=room.players[room.lastCapturePlayerIndex];
      const rem=[...room.table]; room.table=[];
      lp.captured.push(...rem);
      log(code,`last capture: ${lp.name} gets ${rem.map(cardStr).join(',')}`);
      io.to(code).emit('play_result',{playerName:lp.name,playedCard:null,capturedCards:rem,isScopa:false,isTrail:false,isLastCapture:true});
      setBusy(room,true);
      setTimeout(()=>{
        setBusy(room,false);
        room.roundScores=computeRoundScores(room);
        room.phase=checkGameOver(room)?'game_end':'round_end';
        broadcast(code);
      },2500);
      return;
    }
    room.roundScores=computeRoundScores(room);
    room.phase=checkGameOver(room)?'game_end':'round_end';
    log(code,`round over, phase=${room.phase}`);
    return;
  }
  const n=room.players.length;
  let next=(room.currentPlayerIndex+1)%n, tries=0;
  while(room.players[next].hand.length===0&&tries<n){next=(next+1)%n;tries++;}
  room.currentPlayerIndex=next;
  log(code,`turn -> ${room.players[next].name} (bot=${room.players[next].isBot})`);
  if (room.players[next].isBot) scheduleBotWatchdog(room,code,room.players[next].id);
}

// ─── Execute Play ─────────────────────────────────────────────────────────────
function executeCapture(room, playerIndex, cardIndex, captureIndices) {
  const player=room.players[playerIndex];
  const card=player.hand[cardIndex];
  const captured=captureIndices.map(i=>room.table[i]);
  player.captured.push(card,...captured);
  player.hand.splice(cardIndex,1);
  room.table=room.table.filter((_,i)=>!captureIndices.includes(i));
  room.lastCapturePlayerIndex=playerIndex;
  const allHandsEmpty=room.players.every(p=>p.hand.length===0);
  const isLastPlay=allHandsEmpty&&room.deck.length===0;
  let isScopa=false;
  if (room.table.length===0&&!isLastPlay) {
    player.scopas++; isScopa=true;
    io.to(room.code).emit('scopa_announce',{playerName:player.name});
    log(room.code,`SCOPA by ${player.name}`);
  }
  log(room.code,`${player.name} captures ${cardStr(card)} -> ${captured.map(cardStr).join(',')}`);
  io.to(room.code).emit('play_result',{playerName:player.name,playedCard:card,capturedCards:captured,isScopa,isTrail:false});
  io.to(room.code).emit('game_log',{text:`${player.name} captured ${cardStr(card)}${captured.length?` → ${captured.map(cardStr).join(', ')}`:''}`});
  broadcast(room.code);
  setBusy(room,true);
  setTimeout(()=>{
    setBusy(room,false);
    advanceTurn(room,room.code);
    broadcast(room.code);
  },2500);
}

// ─── Bot AI ───────────────────────────────────────────────────────────────────
function botPlayTurn(room, code) {
  log(code,`botPlayTurn: phase=${room.phase} busy=${room.busy} cur=${room.players[room.currentPlayerIndex]?.name}`);
  if (room.phase!=='playing') return;
  if (room.busy) { log(code,'botPlayTurn: busy, aborting (watchdog will retry)'); return; }
  const botIndex=room.currentPlayerIndex;
  const bot=room.players[botIndex];
  if (!bot||!bot.isBot) { log(code,`botPlayTurn: currentPlayer is not bot!`); return; }
  if (bot.hand.length===0) { log(code,'bot hand empty, advancing'); advanceTurn(room,code); broadcast(code); return; }

  let played=false;
  for (let ci=0;ci<bot.hand.length;ci++) {
    const card=bot.hand[ci];
    const directIdx=room.table.findIndex(t=>t.value===card.value);
    if (directIdx!==-1) { executeCapture(room,botIndex,ci,[directIdx]); played=true; break; }
    const caps=findCaptures(card.value,room.table);
    if (caps.length>0) { executeCapture(room,botIndex,ci,caps.find(c=>c.length===room.table.length)||caps[0]); played=true; break; }
  }

  if (!played) {
    const sorted=bot.hand.map((c,i)=>({c,i})).sort((a,b)=>a.c.value-b.c.value);
    const {c:trailCard,i:trailIdx}=sorted[0];
    bot.hand.splice(trailIdx,1); room.table.push(trailCard);
    log(code,`${bot.name} trails ${cardStr(trailCard)}`);
    io.to(code).emit('play_result',{playerName:bot.name,playedCard:trailCard,capturedCards:[],isScopa:false,isTrail:true});
    io.to(code).emit('game_log',{text:`${bot.name} throws ${cardStr(trailCard)}`});
    broadcast(code);
    setBusy(room,true);
    setTimeout(()=>{
      setBusy(room,false);
      advanceTurn(room,code);
      broadcast(code);
    },2000);
  }
}

function scheduleBotWatchdog(room, code, botId) {
  log(code,`scheduling watchdog for bot ${botId}`);
  setTimeout(()=>runBotWatchdog(room,code,botId,0),1200);
}
function runBotWatchdog(room,code,botId,attempts) {
  if (room.phase!=='playing') { log(code,`watchdog: phase=${room.phase}, stopping`); return; }
  const cur=room.players[room.currentPlayerIndex];
  if (!cur||cur.id!==botId) { log(code,`watchdog: turn moved on (now ${cur?.name}), stopping`); return; }
  if (room.busy) {
    log(code,`watchdog attempt ${attempts}: still busy (set ${Date.now()-room.busySetAt}ms ago)`);
    if (attempts<25) setTimeout(()=>runBotWatchdog(room,code,botId,attempts+1),400);
    else log(code,`watchdog TIMEOUT after ${attempts} attempts - game may be stuck!`);
    return;
  }
  log(code,`watchdog firing botPlayTurn for ${cur.name}`);
  botPlayTurn(room,code);
}
function triggerBotIfNeeded(room,code) {
  if (room.phase!=='playing') return;
  const cur=room.players[room.currentPlayerIndex];
  if (cur&&cur.isBot) scheduleBotWatchdog(room,code,cur.id);
}

// ─── Socket Handlers ──────────────────────────────────────────────────────────
io.on('connection',(socket)=>{
  socket.on('create_room',({name})=>{
    const code=createRoom(socket.id,name);
    socket.join(code);
    socket.emit('room_created',{code});
    broadcast(code);
  });
  socket.on('join_room',({code,name})=>{
    const room=getRoom(code);
    if (!room) return socket.emit('error',{message:'Room not found'});
    if (room.phase!=='lobby') return socket.emit('error',{message:'Game already started'});
    if (room.players.length>=4) return socket.emit('error',{message:'Room is full'});
    if (room.players.find(p=>p.name.toLowerCase()===name.toLowerCase())) return socket.emit('error',{message:'Name taken'});
    room.players.push({id:socket.id,name,isHost:false,isBot:false,score:0,hand:[],captured:[],scopas:0,teamIndex:room.players.length});
    socket.join(code);
    socket.emit('room_joined',{code});
    broadcast(code);
  });
  socket.on('add_bot',({code})=>{
    const room=getRoom(code); if(!room||room.phase!=='lobby') return;
    if(!room.players.find(p=>p.id===socket.id)?.isHost) return;
    if(room.players.length>=4) return socket.emit('error',{message:'Room full'});
    const botNames=['Bot Avi','Bot Bina','Bot Gal','Bot Dan'];
    const used=room.players.map(p=>p.name);
    const botName=botNames.find(n=>!used.includes(n))||`Bot ${room.players.length}`;
    room.players.push({id:`bot_${Date.now()}`,name:botName,isHost:false,isBot:true,score:0,hand:[],captured:[],scopas:0,teamIndex:room.players.length});
    broadcast(code);
  });
  socket.on('remove_bot',({code})=>{
    const room=getRoom(code); if(!room||room.phase!=='lobby') return;
    if(!room.players.find(p=>p.id===socket.id)?.isHost) return;
    const idx=[...room.players].reverse().findIndex(p=>p.isBot);
    if(idx===-1) return;
    room.players.splice(room.players.length-1-idx,1);
    broadcast(code);
  });
  socket.on('set_teams',({code,teamAssignments})=>{
    const room=getRoom(code); if(!room||room.phase!=='lobby') return;
    if(!room.players.find(p=>p.id===socket.id)?.isHost) return;
    if(room.players.length!==4) return;
    const t0=teamAssignments.map((t,i)=>({t,i})).filter(x=>x.t===0).map(x=>x.i);
    const t1=teamAssignments.map((t,i)=>({t,i})).filter(x=>x.t===1).map(x=>x.i);
    if(t0.length!==2||t1.length!==2) return socket.emit('error',{message:'Each team needs 2 players'});
    const ordered=[room.players[t0[0]],room.players[t1[0]],room.players[t0[1]],room.players[t1[1]]];
    ordered[0].teamIndex=0; ordered[2].teamIndex=0; ordered[1].teamIndex=1; ordered[3].teamIndex=1;
    room.players=ordered; room.teams=[[0,2],[1,3]];
    broadcast(code);
  });
  socket.on('clear_teams',({code})=>{
    const room=getRoom(code); if(!room||room.phase!=='lobby') return;
    if(!room.players.find(p=>p.id===socket.id)?.isHost) return;
    room.teams=null; room.players.forEach((p,i)=>p.teamIndex=i);
    broadcast(code);
  });
  socket.on('start_game',({code})=>{
    const room=getRoom(code); if(!room) return;
    if(!room.players.find(p=>p.id===socket.id)?.isHost) return;
    if(room.players.length<2) return socket.emit('error',{message:'Need 2+ players'});
    if(room.players.length===4&&room.teams===null) return socket.emit('error',{message:'Assign teams first'});
    log(code,`game started by host`);
    startNewRound(room); broadcast(code);
    triggerBotIfNeeded(room,code);
  });
  socket.on('shuffle_done',({code})=>{
    const room=getRoom(code); if(!room||room.phase!=='shuffle') return;
    if(room.players[room.dealerIndex].id!==socket.id) return;
    room.deck=shuffleDeck(room.deck); room.pendingShuffle=false; room.pendingCut=true; room.phase='cut';
    const n=room.players.length, ci=(room.dealerIndex-1+n)%n;
    if(room.players[ci].isBot){room.deck=cutDeck(room.deck);room.pendingCut=false;dealCards(room);triggerBotIfNeeded(room,code);}
    broadcast(code);
  });
  socket.on('cut_done',({code})=>{
    const room=getRoom(code); if(!room||room.phase!=='cut') return;
    const n=room.players.length, ci=(room.dealerIndex-1+n)%n;
    if(room.players[ci].id!==socket.id) return;
    room.deck=cutDeck(room.deck); room.pendingCut=false; dealCards(room);
    triggerBotIfNeeded(room,code); broadcast(code);
  });
  socket.on('play_card',({code,cardIndex,captureIndices})=>{
    const room=getRoom(code); if(!room||room.phase!=='playing') return;
    if(room.busy){log(code,`play_card ignored: busy`); return;}
    const pi=room.players.findIndex(p=>p.id===socket.id);
    if(pi!==room.currentPlayerIndex){log(code,`play_card ignored: not your turn`); return;}
    const player=room.players[pi];
    if(cardIndex<0||cardIndex>=player.hand.length) return;
    const card=player.hand[cardIndex];
    const possibleCaptures=findCaptures(card.value,room.table);
    const mustCapture=possibleCaptures.length>0;
    if(mustCapture){
      const directIdx=room.table.findIndex(t=>t.value===card.value);
      if(directIdx!==-1) captureIndices=[directIdx];
      else {
        if(!captureIndices||captureIndices.length===0) captureIndices=possibleCaptures[0];
        if(!possibleCaptures.some(combo=>combo.length===captureIndices.length&&combo.every(i=>captureIndices.includes(i))))
          return socket.emit('error',{message:'Invalid capture'});
      }
      executeCapture(room,pi,cardIndex,captureIndices);
    } else {
      player.hand.splice(cardIndex,1); room.table.push(card);
      log(code,`${player.name} trails ${cardStr(card)}`);
      io.to(code).emit('play_result',{playerName:player.name,playedCard:card,capturedCards:[],isScopa:false,isTrail:true});
      io.to(code).emit('game_log',{text:`${player.name} throws ${cardStr(card)}`});
      setBusy(room,true);
      setTimeout(()=>{setBusy(room,false);advanceTurn(room,code);broadcast(code);},2000);
    }
  });
  socket.on('next_round',({code})=>{
    const room=getRoom(code); if(!room||room.phase!=='round_end') return;
    if(!room.players.find(p=>p.id===socket.id)?.isHost) return;
    startNewRound(room); broadcast(code);
    triggerBotIfNeeded(room,code);
  });
  socket.on('disconnect',()=>{
    for (const code in rooms) {
      const room=rooms[code];
      const idx=room.players.findIndex(p=>p.id===socket.id);
      if(idx!==-1){
        const leaving=room.players[idx];
        log(code,`${leaving.name} disconnected`);
        io.to(code).emit('player_left',{name:leaving.name});
        if(room.phase!=='lobby'&&room.teams!==null){
          const botNames=['Bot Avi','Bot Bina','Bot Gal','Bot Dan'];
          const used=room.players.map(p=>p.name);
          const botName=botNames.find(n=>!used.includes(n))||`Bot ${idx}`;
          room.players[idx]={id:`bot_${Date.now()}`,name:botName,isHost:leaving.isHost,isBot:true,
            score:leaving.score,hand:leaving.hand,captured:leaving.captured,scopas:leaving.scopas,teamIndex:leaving.teamIndex};
          if(leaving.isHost){const nh=room.players.find(p=>!p.isBot);if(nh){nh.isHost=true;room.players[idx].isHost=false;}}
          io.to(code).emit('player_replaced',{name:leaving.name,botName});
          log(code,`replaced ${leaving.name} with bot ${botName}`);
          if(room.phase==='playing'&&room.currentPlayerIndex===idx&&!room.busy) scheduleBotWatchdog(room,code,room.players[idx].id);
        } else {
          room.players.splice(idx,1);
          if(room.players.length===0){delete rooms[code];return;}
          if(!room.players.find(p=>p.isHost)) room.players[0].isHost=true;
          if(room.phase!=='lobby'&&room.players.filter(p=>!p.isBot).length<=1) room.phase='game_end';
        }
        broadcast(code); break;
      }
    }
  });
});

const PORT=process.env.PORT||3000;
server.listen(PORT,'0.0.0.0',()=>console.log(`Scopa server running on http://0.0.0.0:${PORT}`));

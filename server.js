const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const STATE_FILE = process.env.STATE_FILE ? path.resolve(process.env.STATE_FILE) : path.join(DATA_DIR, 'state.json');

const config = {
  houseEdge: 0.03,
  protectionFloorRtp: 0.8,
  protectionMaxRtp: 1,
  baseProtectionDeviation: 0.12,
  maxProtectionDeviation: 0.65,
  maxProtectionMoves: 3,
  autoDeductThreshold: 0,
  autoDeductType: 'percent',
  autoDeductValue: 0,
  minBet: 1,
  maxBet: 1000,
  betLevels: [1, 5, 10, 20, 50, 100],
  startingBalance: 1000,
};

const users = new Map();
const games = new Map();
let prizePool = 0;
let totalPlatformDeducted = 0;

function gameToRecord(game) {
  return {
    ...game,
    revealed: Array.from(game.revealed || []),
    displayMines: game.displayMines ? Array.from(game.displayMines) : null,
  };
}

function recordToGame(record) {
  return {
    ...record,
    revealed: new Set(record.revealed || []),
    displayMines: record.displayMines ? new Set(record.displayMines) : null,
    decisions: Array.isArray(record.decisions) ? record.decisions : [],
    protection: record.protection || {
      active: false,
      floorRtp: config.protectionFloorRtp,
      maxRtp: config.protectionMaxRtp,
      startingRtp: 1,
      deviation: 0,
      movesRemaining: 0,
      movesUsed: 0,
      events: [],
    },
  };
}

function saveState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const data = {
    savedAt: nowIso(),
    config,
    prizePool,
    totalPlatformDeducted,
    users: Array.from(users.values()),
    games: Array.from(games.values()).map(gameToRecord),
  };
  const tmpFile = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  fs.renameSync(tmpFile, STATE_FILE);
}

function persistState() {
  try {
    saveState();
  } catch (error) {
    console.warn(`Failed to persist state: ${error.message}`);
  }
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data.config && typeof data.config === 'object') {
      Object.keys(config).forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(data.config, key)) {
          config[key] = data.config[key];
        }
      });
      applyBetLevels(config.betLevels);
    }
    if (typeof data.prizePool === 'number') {
      prizePool = data.prizePool;
    }
    if (typeof data.totalPlatformDeducted === 'number') {
      totalPlatformDeducted = data.totalPlatformDeducted;
    }
    if (Array.isArray(data.users)) {
      data.users.forEach((user) => {
        if (user && user.id) users.set(user.id, user);
      });
    }
    if (Array.isArray(data.games)) {
      data.games.forEach((game) => {
        if (game && game.id) games.set(game.id, recordToGame(game));
      });
    }
  } catch (error) {
    console.warn(`Failed to load state from ${STATE_FILE}: ${error.message}`);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function publicNumber(value, digits = 4) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function normalizeBetLevels(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  const levels = source
    .map((item) => toMoney(item))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => clamp(item, 0.01, 100000));
  const unique = Array.from(new Set(levels)).sort((a, b) => a - b);
  return unique.length ? unique : [1, 5, 10, 20, 50, 100];
}

function applyBetLevels(levels) {
  config.betLevels = normalizeBetLevels(levels);
  config.minBet = config.betLevels[0];
  config.maxBet = config.betLevels[config.betLevels.length - 1];
}

function nearestBetLevel(value) {
  const amount = toMoney(value);
  return config.betLevels.reduce((best, level) => (
    Math.abs(level - amount) < Math.abs(best - amount) ? level : best
  ), config.betLevels[0]);
}

function getUser(userId = 'demo') {
  const id = String(userId || 'demo').slice(0, 64);
  if (!users.has(id)) {
    users.set(id, {
      id,
      balance: config.startingBalance,
      totalWagered: 0,
      totalPaidOut: 0,
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      protectedMoves: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    persistState();
  }
  return users.get(id);
}

function getPeriodStats(userId, periodMinutes) {
  if (!periodMinutes || periodMinutes <= 0) {
    const user = users.get(userId);
    return { wagered: user ? user.totalWagered : 0, paidOut: user ? user.totalPaidOut : 0 };
  }
  const cutoff = new Date(Date.now() - periodMinutes * 60 * 1000).toISOString();
  let wagered = 0;
  let paidOut = 0;
  for (const game of games.values()) {
    if (game.userId === userId && game.createdAt >= cutoff) {
      wagered += game.bet;
      if ((game.status === 'cashed_out' || game.status === 'won') && game.cashout) {
        paidOut += game.cashout.current;
      }
    }
  }
  return { wagered, paidOut };
}

function getRtp(user, periodStats = null) {
  if (periodStats) {
    if (!periodStats.wagered) return 1;
    return periodStats.paidOut / periodStats.wagered;
  }
  if (!user.totalWagered) return 1;
  return user.totalPaidOut / user.totalWagered;
}

function getPayoutRoom(user, periodStats = null) {
  if (periodStats) {
    return Math.max(0, periodStats.wagered * config.protectionMaxRtp - periodStats.paidOut);
  }
  return Math.max(0, user.totalWagered * config.protectionMaxRtp - user.totalPaidOut);
}

function getActiveGame(userId) {
  const ordered = Array.from(games.values()).reverse();
  return ordered.find((game) => game.userId === userId && game.status === 'active') || null;
}

function checkAutoDeductPool() {
  if (config.autoDeductThreshold > 0 && prizePool >= config.autoDeductThreshold) {
    let deduct = 0;
    if (config.autoDeductType === 'percent') {
      deduct = prizePool * (config.autoDeductValue / 100);
    } else {
      deduct = config.autoDeductValue;
    }
    if (deduct > prizePool) deduct = prizePool;
    if (deduct > 0) {
      prizePool = toMoney(prizePool - deduct);
      totalPlatformDeducted = toMoney(totalPlatformDeducted + deduct);
    }
  }
}

function makeProtection(user, rtpBasis, payoutRoom) {
  const periodStats = getPeriodStats(user.id, config.rtpPeriodMinutes);
  const rtp = Number.isFinite(rtpBasis) ? rtpBasis : getRtp(user, periodStats);
  const shortfall = Math.max(0, config.protectionFloorRtp - rtp);
  const availablePayoutRoom = Number.isFinite(payoutRoom) ? payoutRoom : getPayoutRoom(user, periodStats);
  const active = shortfall > 0 && availablePayoutRoom > 0 && config.maxProtectionMoves > 0;
  const deviation = active
    ? clamp(config.baseProtectionDeviation + shortfall * 1.25, 0, config.maxProtectionDeviation)
    : 0;
  const movesRemaining = active
    ? clamp(Math.ceil(shortfall * 10), 1, config.maxProtectionMoves)
    : 0;

  return {
    active,
    floorRtp: config.protectionFloorRtp,
    maxRtp: config.protectionMaxRtp,
    startingRtp: publicNumber(rtp),
    deviation: publicNumber(deviation),
    movesRemaining,
    movesUsed: 0,
    events: [],
  };
}

function successProbability(totalCells, safeCells, safeClicks) {
  if (safeClicks <= 0) return 1;
  let probability = 1;
  for (let i = 0; i < safeClicks; i += 1) {
    probability *= (safeCells - i) / (totalCells - i);
  }
  return probability;
}

function intendedPayoutForClicks(game, safeClicks) {
  const totalCells = game.size * game.size;
  const safeCells = totalCells - game.mines;
  if (safeClicks <= 0) return 0;
  const probability = successProbability(totalCells, safeCells, safeClicks);
  if (probability <= 0) return 0;
  return toMoney((game.bet * (1 - game.houseEdge)) / probability);
}

function nextSafeProbability(game) {
  const totalCells = game.size * game.size;
  const safeCells = totalCells - game.mines;
  const opened = game.revealed.size;
  const remainingCells = totalCells - opened;
  const remainingSafe = safeCells - opened;
  if (remainingCells <= 0 || remainingSafe <= 0) return 0;
  return remainingSafe / remainingCells;
}

function intendedPayout(game) {
  return intendedPayoutForClicks(game, game.revealed.size);
}

function payoutPreview(user, game) {
  const intended = intendedPayout(game);
  const periodStats = getPeriodStats(user.id, config.rtpPeriodMinutes);
  const userCap = toMoney(getPayoutRoom(user, periodStats));
  const poolCap = toMoney(prizePool);
  const cap = Math.min(userCap, poolCap);
  const current = toMoney(Math.min(intended, cap));
  return {
    intended,
    current,
    cap,
    capped: intended > current,
  };
}

function settlePayout(user, game) {
  const preview = payoutPreview(user, game);
  user.balance = toMoney(user.balance + preview.current);
  user.totalPaidOut = toMoney(user.totalPaidOut + preview.current);
  prizePool = toMoney(prizePool - preview.current);
  user.updatedAt = nowIso();
  return preview;
}

function tryProtectionSafe(user, game, clickedIndex, baseRoll, mineProbability) {
  const periodStats = getPeriodStats(user.id, config.rtpPeriodMinutes);
  const payoutRoom = getPayoutRoom(user, periodStats);
  const safeClicksAfter = game.revealed.size + 1;
  const protectedPayout = intendedPayoutForClicks(game, safeClicksAfter);

  if (!game.protection.active || game.protection.movesRemaining <= 0) {
    return { applied: false, reason: 'inactive' };
  }
  if (getRtp(user, periodStats) >= config.protectionFloorRtp) {
    return { applied: false, reason: 'rtp_not_low' };
  }
  if (protectedPayout > payoutRoom + 0.0001) {
    return {
      applied: false,
      reason: 'rtp_cap',
      protectedPayout,
      payoutRoom: toMoney(payoutRoom),
    };
  }

  const protectionRoll = Math.random();
  if (protectionRoll >= game.protection.deviation) {
    return {
      applied: false,
      reason: 'protection_roll_missed',
      protectionRoll: publicNumber(protectionRoll),
      deviation: game.protection.deviation,
    };
  }

  game.protection.movesRemaining -= 1;
  game.protection.movesUsed += 1;
  user.protectedMoves += 1;
  user.updatedAt = nowIso();

  const event = {
    at: nowIso(),
    clickedIndex,
    baseRoll: publicNumber(baseRoll),
    protectionRoll: publicNumber(protectionRoll),
    mineProbability: publicNumber(mineProbability),
    deviation: game.protection.deviation,
    protectedPayout,
    payoutRoom: toMoney(payoutRoom),
    result: 'forced_safe',
  };
  game.protection.events.push(event);
  return { applied: true, event };
}

function makeDisplayMines(game, losingIndex = null) {
  const totalCells = game.size * game.size;
  const mines = new Set();
  if (Number.isInteger(losingIndex)) mines.add(losingIndex);

  const candidates = [];
  for (let i = 0; i < totalCells; i += 1) {
    if (game.revealed.has(i)) continue;
    if (mines.has(i)) continue;
    candidates.push(i);
  }

  while (mines.size < game.mines && candidates.length) {
    const pick = crypto.randomInt(0, candidates.length);
    mines.add(candidates[pick]);
    candidates.splice(pick, 1);
  }
  return mines;
}

function serializeUser(user) {
  return {
    id: user.id,
    balance: toMoney(user.balance),
    totalWagered: toMoney(user.totalWagered),
    totalPaidOut: toMoney(user.totalPaidOut),
    rtp: publicNumber(getRtp(user)),
    rtpPercent: publicNumber(getRtp(user) * 100, 2),
    gamesPlayed: user.gamesPlayed,
    wins: user.wins,
    losses: user.losses,
    protectedMoves: user.protectedMoves,
  };
}

function serializeGame(game, user, options = {}) {
  if (!game) return null;
  const revealMines = Boolean(options.revealMines);
  const admin = Boolean(options.admin);
  const safeClicks = game.revealed.size;
  return {
    id: game.id,
    userId: game.userId,
    size: game.size,
    mines: game.mines,
    bet: game.bet,
    status: game.status,
    safeClicks,
    revealed: Array.from(game.revealed),
    mineIndexes: revealMines && game.displayMines ? Array.from(game.displayMines) : undefined,
    nextSafeProbability: publicNumber(nextSafeProbability(game)),
    cashout: payoutPreview(user, game),
    createdAt: game.createdAt,
    endedAt: game.endedAt,
    decisions: admin ? game.decisions : undefined,
    protection: admin ? game.protection : {
      active: game.protection.active,
      floorRtp: game.protection.floorRtp,
      maxRtp: game.protection.maxRtp,
      startingRtp: game.protection.startingRtp,
      deviation: game.protection.deviation,
      movesRemaining: game.protection.movesRemaining,
      movesUsed: game.protection.movesUsed,
    },
  };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const user = getUser(url.searchParams.get('userId') || 'demo');
    const game = getActiveGame(user.id);
    sendJson(res, 200, {
      user: serializeUser(user),
      game: serializeGame(game, user),
      config: {
        minBet: config.minBet,
        maxBet: config.maxBet,
        betLevels: config.betLevels,
        houseEdge: config.houseEdge,
        protectionFloorRtp: config.protectionFloorRtp,
        protectionMaxRtp: config.protectionMaxRtp,
      },
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/deposit') {
    const body = await readBody(req);
    const user = getUser(body.userId || 'demo');
    const amount = clamp(toMoney(body.amount), 1, 100000);
    user.balance = toMoney(user.balance + amount);
    user.updatedAt = nowIso();
    persistState();
    sendJson(res, 200, { user: serializeUser(user) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/game/start') {
    const body = await readBody(req);
    const user = getUser(body.userId || 'demo');
    if (getActiveGame(user.id)) {
      sendError(res, 409, 'Finish or abandon the active round first.');
      return;
    }

    const size = clamp(parseInt(body.size, 10) || 5, 3, 10);
    const totalCells = size * size;
    const mines = clamp(parseInt(body.mines, 10) || 5, 1, totalCells - 1);
    const requestedBet = toMoney(body.bet);
    const bet = nearestBetLevel(requestedBet);
    if (Math.abs(bet - requestedBet) > 0.0001) {
      sendError(res, 400, 'Invalid bet level.');
      return;
    }

    if (user.balance < bet) {
      sendError(res, 400, 'Insufficient balance.');
      return;
    }

    user.balance = toMoney(user.balance - bet);
    user.totalWagered = toMoney(user.totalWagered + bet);
    prizePool = toMoney(prizePool + bet);
    checkAutoDeductPool();
    user.gamesPlayed += 1;
    user.updatedAt = nowIso();
    const protection = makeProtection(user);

    const game = {
      id: crypto.randomUUID(),
      userId: user.id,
      size,
      mines,
      bet,
      houseEdge: config.houseEdge,
      revealed: new Set(),
      displayMines: null,
      decisions: [],
      status: 'active',
      createdAt: nowIso(),
      endedAt: null,
      protection,
    };

    games.set(game.id, game);
    persistState();
    sendJson(res, 200, { user: serializeUser(user), game: serializeGame(game, user) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/game/reveal') {
    const body = await readBody(req);
    const game = games.get(String(body.gameId || ''));
    if (!game || game.status !== 'active') {
      sendError(res, 404, 'Active round not found.');
      return;
    }

    const user = getUser(game.userId);
    const totalCells = game.size * game.size;
    const index = parseInt(body.index, 10);
    if (!Number.isInteger(index) || index < 0 || index >= totalCells) {
      sendError(res, 400, 'Invalid cell index.');
      return;
    }
    if (game.revealed.has(index)) {
      sendError(res, 400, 'Cell already opened.');
      return;
    }

    const safeProbability = nextSafeProbability(game);
    const mineProbability = 1 - safeProbability;
    const baseRoll = Math.random();
    let protectionResult = null;
    let hitMine = baseRoll < mineProbability;
    let forcedByPool = false;

    if (hitMine) {
      protectionResult = tryProtectionSafe(user, game, index, baseRoll, mineProbability);
      if (protectionResult.applied) hitMine = false;
    }

    if (!hitMine) {
      const safeClicksAfter = game.revealed.size + 1;
      const potentialPayout = intendedPayoutForClicks(game, safeClicksAfter);
      if (potentialPayout > prizePool) {
        hitMine = true;
        forcedByPool = true;
      }
    }

    game.decisions.push({
      at: nowIso(),
      index,
      baseRoll: publicNumber(baseRoll),
      safeProbability: publicNumber(safeProbability),
      mineProbability: publicNumber(mineProbability),
      result: hitMine ? 'mine' : 'safe',
      protected: Boolean(protectionResult && protectionResult.applied),
      protectionFailedReason: protectionResult && !protectionResult.applied ? protectionResult.reason : null,
      forcedByPool,
    });

    if (hitMine) {
      game.displayMines = makeDisplayMines(game, index);
      game.status = 'lost';
      game.endedAt = nowIso();
      user.losses += 1;
      user.updatedAt = nowIso();
      persistState();
      sendJson(res, 200, {
        result: 'mine',
        user: serializeUser(user),
        game: serializeGame(game, user, { revealMines: true }),
        protectionResult,
      });
      return;
    }

    game.revealed.add(index);
    const safeCells = totalCells - game.mines;
    if (game.revealed.size >= safeCells) {
      const payout = settlePayout(user, game);
      game.displayMines = makeDisplayMines(game);
      game.status = 'won';
      game.endedAt = nowIso();
      user.wins += 1;
      user.updatedAt = nowIso();
      persistState();
      sendJson(res, 200, {
        result: 'win',
        payout,
        user: serializeUser(user),
        game: serializeGame(game, user, { revealMines: true }),
        protectionResult,
      });
      return;
    }

    persistState();
    sendJson(res, 200, {
      result: 'safe',
      user: serializeUser(user),
      game: serializeGame(game, user),
      protectionResult,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/game/cashout') {
    const body = await readBody(req);
    const game = games.get(String(body.gameId || ''));
    if (!game || game.status !== 'active') {
      sendError(res, 404, 'Active round not found.');
      return;
    }

    const user = getUser(game.userId);
    if (game.revealed.size <= 0) {
      sendError(res, 400, 'Open at least one safe cell before cashing out.');
      return;
    }

    const payout = settlePayout(user, game);
    game.displayMines = makeDisplayMines(game);
    game.status = 'cashed_out';
    game.endedAt = nowIso();
    user.wins += 1;
    user.updatedAt = nowIso();
    persistState();
    sendJson(res, 200, {
      result: 'cashed_out',
      payout,
      user: serializeUser(user),
      game: serializeGame(game, user, { revealMines: true }),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/game/abandon') {
    const body = await readBody(req);
    const game = games.get(String(body.gameId || ''));
    if (!game || game.status !== 'active') {
      sendError(res, 404, 'Active round not found.');
      return;
    }

    const user = getUser(game.userId);
    game.displayMines = makeDisplayMines(game);
    game.status = 'abandoned';
    game.endedAt = nowIso();
    user.losses += 1;
    user.updatedAt = nowIso();
    persistState();
    sendJson(res, 200, {
      result: 'abandoned',
      user: serializeUser(user),
      game: serializeGame(game, user, { revealMines: true }),
    });
    return;
  }

  if (url.pathname.startsWith('/api/admin')) {
    if (req.method === 'GET' && url.pathname === '/api/admin/summary') {
      const userList = Array.from(users.values()).map(user => {
        const serialized = serializeUser(user);
        const periodStats = getPeriodStats(user.id, config.rtpPeriodMinutes);
        serialized.periodRtpPercent = publicNumber(getRtp(user, periodStats) * 100, 2);
        return serialized;
      });
      const gameList = Array.from(games.values())
        .reverse()
        .map((game) => serializeGame(game, getUser(game.userId), { revealMines: true, admin: true }));
      
      const totals = userList.reduce((acc, user) => {
        acc.balance = toMoney(acc.balance + user.balance);
        acc.totalWagered = toMoney(acc.totalWagered + user.totalWagered);
        acc.totalPaidOut = toMoney(acc.totalPaidOut + user.totalPaidOut);
        acc.protectedMoves += user.protectedMoves;
        return acc;
      }, { balance: 0, totalWagered: 0, totalPaidOut: 0, protectedMoves: 0, prizePool: toMoney(prizePool), totalPlatformDeducted: toMoney(totalPlatformDeducted) });
      totals.rtp = totals.totalWagered ? publicNumber(totals.totalPaidOut / totals.totalWagered) : 1;
      totals.rtpPercent = publicNumber(totals.rtp * 100, 2);

      const dailyStats = {};
      const dailyUserStats = {};

      gameList.forEach((g) => {
        const date = g.createdAt.split('T')[0];
        if (!dailyStats[date]) {
          dailyStats[date] = { date, wagered: 0, paidOut: 0, games: 0, users: new Set() };
        }
        const userKey = `${date}_${g.userId}`;
        if (!dailyUserStats[userKey]) {
          dailyUserStats[userKey] = { date, userId: g.userId, wagered: 0, paidOut: 0, games: 0 };
        }

        dailyStats[date].wagered += g.bet;
        dailyUserStats[userKey].wagered += g.bet;

        if (g.cashout && g.status !== 'active' && g.status !== 'lost' && g.status !== 'abandoned') {
          dailyStats[date].paidOut += g.cashout.current;
          dailyUserStats[userKey].paidOut += g.cashout.current;
        }
        
        dailyStats[date].games += 1;
        dailyStats[date].users.add(g.userId);
        
        dailyUserStats[userKey].games += 1;
      });
      
      const dailyList = Object.values(dailyStats).map(d => {
        const profit = d.wagered - d.paidOut;
        const profitPct = d.wagered > 0 ? (profit / d.wagered * 100) : 0;
        return {
          date: d.date,
          wagered: toMoney(d.wagered),
          paidOut: toMoney(d.paidOut),
          profit: `${toMoney(profit)} (${publicNumber(profitPct, 2)}%)`,
          games: d.games,
          activeUsers: d.users.size,
        };
      }).sort((a, b) => b.date.localeCompare(a.date));

      const dailyUsersList = Object.values(dailyUserStats).map(u => {
        const rtp = u.wagered ? u.paidOut / u.wagered : 1;
        return {
          date: u.date,
          userId: u.userId,
          wagered_raw: u.wagered,
          wagered: toMoney(u.wagered),
          paidOut: toMoney(u.paidOut),
          rtpPercent: publicNumber(rtp * 100, 2),
          games: u.games,
        };
      }).sort((a, b) => {
        if (a.date !== b.date) return b.date.localeCompare(a.date);
        return b.wagered_raw - a.wagered_raw;
      });

      sendJson(res, 200, {
        config,
        totals,
        users: userList,
        games: gameList.slice(0, 100),
        daily: dailyList,
        dailyUsers: dailyUsersList,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/prizepool') {
      const body = await readBody(req);
      const adjust = Number(body.amount);
      if (Number.isFinite(adjust)) {
        prizePool = toMoney(prizePool + adjust);
        if (adjust > 0) checkAutoDeductPool();
        persistState();
      }
      sendJson(res, 200, { prizePool });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/config') {
      const body = await readBody(req);
      const updates = {
        houseEdge: [0, 0.25],
        protectionFloorRtp: [0, 1],
        protectionMaxRtp: [0.5, 1],
        baseProtectionDeviation: [0, 1],
        maxProtectionDeviation: [0, 1],
        maxProtectionMoves: [0, 10],
        startingBalance: [0, 1000000],
      };

      if (Object.prototype.hasOwnProperty.call(body, 'betLevels')) {
        applyBetLevels(body.betLevels);
      }

      Object.entries(updates).forEach(([key, range]) => {
        if (Object.prototype.hasOwnProperty.call(body, key)) {
          const raw = key === 'maxProtectionMoves' ? parseInt(body[key], 10) : Number(body[key]);
          if (Number.isFinite(raw)) {
            config[key] = key === 'maxProtectionMoves'
              ? Math.round(clamp(raw, range[0], range[1]))
              : publicNumber(clamp(raw, range[0], range[1]));
          }
        }
      });

      if (config.minBet > config.maxBet) {
        applyBetLevels(config.betLevels);
      }
      if (config.baseProtectionDeviation > config.maxProtectionDeviation) {
        config.baseProtectionDeviation = config.maxProtectionDeviation;
      }

      persistState();
      sendJson(res, 200, { config });
      return;
    }
  }

  sendError(res, 404, 'API route not found.');
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/admin') pathname = '/admin.html';

  const filePath = path.normalize(path.join(ROOT, pathname));
  const relativePath = path.relative(ROOT, filePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml; charset=utf-8',
    }[ext] || 'application/octet-stream';

    res.writeHead(200, { 'content-type': mime });
    res.end(data);
  });
}

applyBetLevels(config.betLevels);
loadState();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url);
  } catch (error) {
    sendError(res, 500, error.message || 'Server error.');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Mines server running at http://${HOST}:${PORT}`);
  console.log(`Admin page: http://${HOST}:${PORT}/admin`);
});

/**
 * Raydium Meme Hunter (Solana) — Discord alerts
 *
 * FINAL VERSION - ALL FIXES INCLUDED:
 * ✅ Poll default = 60s (faster scanning)
 * ✅ MAX_AGE_HOURS = 72 (3 days discovery window by default)
 * ✅ DexScreener pairCreatedAt normalized (handles seconds/ms)
 * ✅ Accepts raydium + raydium-clmm dex IDs
 * ✅ Hybrid discovery with fallback
 * ✅ Early-watch system (doesn't burn failed tokens)
 * ✅ Pump monitoring (3-day watch, 100 token check limit)
 * ✅ Smart cooldowns (12h new alerts, 6h pump alerts)
 * ✅ Preferred pair enrichment
 *
 * Run: DISCORD_WEBHOOK_URL="..." node raydium-to-discord.js
 */

const fs = require("fs");
const path = require("path");

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
if (!DISCORD_WEBHOOK_URL) {
  console.error("Missing DISCORD_WEBHOOK_URL env var.");
  process.exit(1);
}

const STATE_FILE = path.join(__dirname, "state.json");

// Config
const POLL_MS = Number(process.env.POLL_MS || 60000); // 60s default
const MAX_ANALYZE = Number(process.env.MAX_ANALYZE || 80);
const ALERT_TOP_N = Number(process.env.ALERT_TOP_N || 15);
const MAX_AGE_HOURS = Number(process.env.MAX_AGE_HOURS || 72); // 3 days discovery window by default
const MIN_AGE_MINUTES = Number(process.env.MIN_AGE_MINUTES || 2);
const WATCH_DAYS = Number(process.env.WATCH_DAYS || 3); // watch coins for 3 days
const WATCH_HOURS = WATCH_DAYS * 24;
const PUMP_CHECK_LIMIT = Number(process.env.PUMP_CHECK_LIMIT || 100);
const MIN_PUMP_AGE_MINUTES = Number(process.env.MIN_PUMP_AGE_MINUTES || 3);
// Pump tier thresholds
const MIN_PUMP_EARLY_LIQ_USD = Number(process.env.MIN_PUMP_EARLY_LIQ_USD || 3000);
const MIN_PUMP_EARLY_M5_TXNS = Number(process.env.MIN_PUMP_EARLY_M5_TXNS || 20);
const MIN_PUMP_EARLY_M5_BUYS = Number(process.env.MIN_PUMP_EARLY_M5_BUYS || 10);
const MIN_PUMP_EARLY_M5_VOL_USD = Number(process.env.MIN_PUMP_EARLY_M5_VOL_USD || 1000);
const MIN_PUMP_CONF_LIQ_USD = Number(process.env.MIN_PUMP_CONF_LIQ_USD || 10000);
const MIN_PUMP_CONF_M5_TXNS = Number(process.env.MIN_PUMP_CONF_M5_TXNS || 35);
const MIN_PUMP_CONF_M5_BUYS = Number(process.env.MIN_PUMP_CONF_M5_BUYS || 18);
const MIN_PUMP_CONF_M5_VOL_USD = Number(process.env.MIN_PUMP_CONF_M5_VOL_USD || 2500);
const MIN_LIQ_USD = Number(process.env.MIN_LIQ_USD || 1200);
const MIN_VOL_24H_USD = Number(process.env.MIN_VOL_24H_USD || 500);
const MAX_MARKETCAP_USD = Number(process.env.MAX_MARKETCAP_USD || 10_000_000);
const SEEN_TTL_DAYS = Number(process.env.SEEN_TTL_DAYS || 14);
const NEW_ALERT_COOLDOWN_HOURS = Number(process.env.NEW_ALERT_COOLDOWN_HOURS || 12);
const PUMP_ALERT_COOLDOWN_HOURS = Number(process.env.PUMP_ALERT_COOLDOWN_HOURS || 6);
const PUMP_5M_PCT = Number(process.env.PUMP_5M_PCT || 8);
const PUMP_VOL_MULT = Number(process.env.PUMP_VOL_MULT || 2.5);
const PUMP_BUYSELL_RATIO = Number(process.env.PUMP_BUYSELL_RATIO || 1.8);
const PUMP_MIN_H1_TXNS = Number(process.env.PUMP_MIN_H1_TXNS || 20);

const DEX_PAIRS_SOLANA = "https://api.dexscreener.com/latest/dex/pairs/solana";
const DEX_TOKEN_DETAILS = (addr) => `https://api.dexscreener.com/latest/dex/tokens/${addr}`;
const RAYDIUM_DEX_IDS = new Set(["raydium", "raydium-clmm"]);
const POPULAR_TOKENS = [
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
];

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!s.seenTokens) s.seenTokens = {};
    return s;
  } catch {
    return { seenTokens: {}, lastRun: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function pruneSeen(state, days = 14) {
  const cutoff = Date.now() - days * 86400000;
  let pruned = 0;
  for (const [addr, meta] of Object.entries(state.seenTokens || {})) {
    const ts = typeof meta === "number" ? meta : Number(meta?.firstSeenAt || meta?.lastCheckedAt || meta?.lastAlertAt || 0);
    if (!ts || ts < cutoff) {
      delete state.seenTokens[addr];
      pruned++;
    }
  }
  if (pruned) console.log(`  🧹 Pruned ${pruned} old tokens`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizePairCreatedAt(t) {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

function getAgeHours(tsMs) {
  return tsMs ? (Date.now() - Number(tsMs)) / 3600000 : 999;
}

function getAgeMinutes(tsMs) {
  return getAgeHours(tsMs) * 60;
}

function formatCurrency(num) {
  const n = Number(num || 0);
  if (!n) return "$0";
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function formatAge(tsMs) {
  if (!tsMs) return "Unknown";
  const mins = getAgeMinutes(tsMs);
  if (mins < 60) return `${Math.round(mins)}m`;
  const hrs = mins / 60;
  if (hrs < 24) return `${Math.round(hrs)}h`;
  return `${Math.round(hrs / 24)}d`;
}

function formatPrice(p) {
  const n = Number(p);
  if (!Number.isFinite(n) || n <= 0) return "n/a";
  if (n >= 1) return `$${n.toFixed(4)}`;
  if (n >= 0.01) return `$${n.toFixed(6)}`;
  return `$${n.toPrecision(6)}`;
}

function getH1Txns(token) {
  const h1 = token.txns?.h1 || {};
  return { buys: Number(h1.buys || 0), sells: Number(h1.sells || 0), total: Number(h1.buys || 0) + Number(h1.sells || 0) };
}

function getM5Txns(token) {
  const m5 = token.txns?.m5 || {};
  return { buys: Number(m5.buys || 0), sells: Number(m5.sells || 0), total: Number(m5.buys || 0) + Number(m5.sells || 0) };
}

function hoursAgo(ms) {
  return (Date.now() - Number(ms || 0)) / 3600000;
}

function canSendCooldown(lastAt, cooldownHours) {
  return !lastAt || hoursAgo(lastAt) >= cooldownHours;
}

async function postToDiscord({ title, description, fields = [], color = 0x00ff00 }) {
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      embeds: [{
        title,
        description,
        fields: fields.slice(0, 24),
        color,
        timestamp: new Date().toISOString(),
      }]
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`Discord failed: ${res.status} ${text}`);
  }
}

// ---------- Heartbeat / Health ----------
const HEARTBEAT_MIN = Number(process.env.HEARTBEAT_MIN || 60); // send "alive" ping every N minutes
let _lastHeartbeatAt = 0;

async function maybeHeartbeat(extra = {}) {
  const now = Date.now();
  const everyMs = HEARTBEAT_MIN * 60 * 1000;
  if (_lastHeartbeatAt && (now - _lastHeartbeatAt) < everyMs) return;

  _lastHeartbeatAt = now;
  const fields = [
    { name: "⏱️ Poll", value: `${Math.round(POLL_MS/1000)}s`, inline: true },
    { name: "🕒 Now", value: new Date().toISOString(), inline: true },
  ];

  if (extra?.watchSize != null) fields.push({ name: "👀 Watch", value: String(extra.watchSize), inline: true });
  if (extra?.seenSize != null) fields.push({ name: "🗂️ Seen", value: String(extra.seenSize), inline: true });

  await postToDiscord({
    title: "✅ Meme Hunter Heartbeat",
    description: "Bot is running and scanning.",
    fields,
    color: 0x2ecc71,
  });
}

async function fetchRecentRaydiumPairs() {
  const now = Date.now();
  const maxAgeMs = MAX_AGE_HOURS * 3600000;
  const minAgeMs = MIN_AGE_MINUTES * 60000;

  try {
    console.log("Trying primary DexScreener feed...");
    const res = await fetch(DEX_PAIRS_SOLANA);
    if (res.ok) {
      const data = await res.json();
      const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
      const filtered = pairs
        .filter(p => p?.chainId === "solana" && RAYDIUM_DEX_IDS.has(p?.dexId))
        .map(p => {
          const createdAt = normalizePairCreatedAt(p?.pairCreatedAt);
          return createdAt ? { p, createdAt } : null;
        })
        .filter(Boolean)
        .filter(({ createdAt }) => {
          const ageMs = now - createdAt;
          return ageMs <= maxAgeMs && ageMs >= minAgeMs;
        });

      const capped = filtered.slice(0, 3000);
      capped.sort((a, b) => (b.p?.liquidity?.usd || 0) - (a.p?.liquidity?.usd || 0));

      const candidates = [];
      const seen = new Set();
      for (const { p } of capped) {
        const addr = p?.baseToken?.address;
        if (!addr || seen.has(addr)) continue;
        seen.add(addr);
        candidates.push({ address: addr, fromPair: p });
        if (candidates.length >= 300) break;
      }

      console.log(`  ✅ Primary: ${candidates.length} candidates`);
      if (candidates.length) return candidates;
    } else {
      console.log(`  ⚠️ Primary: ${res.status}`);
    }
  } catch (e) {
    console.log(`  ⚠️ Primary failed: ${e.message}`);
  }

  console.log("Falling back to popular tokens...");
  const allPairs = [];
  for (const baseToken of POPULAR_TOKENS) {
    try {
      const res = await fetch(DEX_TOKEN_DETAILS(baseToken));
      if (!res.ok) {
        console.log(`  ⚠️ ${baseToken.slice(0, 8)}: ${res.status}`);
        continue;
      }
      const data = await res.json();
      const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
      const raydiumRecent = pairs
        .filter(p => p?.chainId === "solana" && RAYDIUM_DEX_IDS.has(p?.dexId))
        .map(p => {
          const createdAt = normalizePairCreatedAt(p?.pairCreatedAt);
          return createdAt ? { p, createdAt } : null;
        })
        .filter(Boolean)
        .filter(({ createdAt }) => {
          const ageMs = now - createdAt;
          return ageMs <= maxAgeMs && ageMs >= minAgeMs;
        })
        .map(({ p }) => p);

      console.log(`  ✅ ${baseToken.slice(0, 8)}: ${raydiumRecent.length} pairs`);
      allPairs.push(...raydiumRecent);
    } catch (e) {
      console.log(`  ⚠️ ${baseToken.slice(0, 8)}: ${e.message}`);
    }
    await sleep(150);
  }

  allPairs.sort((a, b) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0));
  const candidates = [];
  const seen = new Set();
  for (const p of allPairs) {
    const addr = p?.baseToken?.address;
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    candidates.push({ address: addr, fromPair: p });
    if (candidates.length >= 300) break;
  }

  console.log(`  ✅ Fallback: ${candidates.length} candidates`);
  return candidates;
}

function pickBestPair(pairs, preferredPairAddress) {
  const solRay = pairs.filter(p => p?.chainId === "solana" && RAYDIUM_DEX_IDS.has(p?.dexId));
  if (!solRay.length) return null;
  if (preferredPairAddress) {
    const match = solRay.find(p => p?.pairAddress === preferredPairAddress);
    if (match) return match;
  }
  const now = Date.now();
  const within = solRay
    .map(p => ({ p, createdAt: normalizePairCreatedAt(p?.pairCreatedAt) }))
    .filter(x => x.createdAt && (now - x.createdAt) <= WATCH_HOURS * 3600000);
  const candidates = within.length ? within : solRay.map(p => ({ p, createdAt: normalizePairCreatedAt(p?.pairCreatedAt) || 0 }));
  candidates.sort((a, b) => {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return (b.p?.liquidity?.usd || 0) - (a.p?.liquidity?.usd || 0);
  });
  return candidates[0]?.p || null;
}

async function getTokenDetails(tokenAddress, preferredPairAddress = null) {
  try {
    const res = await fetch(DEX_TOKEN_DETAILS(tokenAddress));
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = Array.isArray(data?.pairs) ? data.pairs : [];
    const pair = pickBestPair(pairs, preferredPairAddress);
    if (!pair) return null;
    const createdAt = normalizePairCreatedAt(pair?.pairCreatedAt);
    return {
      address: tokenAddress,
      symbol: pair?.baseToken?.symbol || "UNKNOWN",
      name: pair?.baseToken?.name || "Unknown",
      pairAddress: pair?.pairAddress,
      price: Number(pair?.priceUsd || 0),
      priceChange5m: Number(pair?.priceChange?.m5 || 0),
      priceChange1h: Number(pair?.priceChange?.h1 || 0),
      priceChange24h: Number(pair?.priceChange?.h24 || 0),
      volumeM5: Number(pair?.volume?.m5 || 0),
      volumeH1: Number(pair?.volume?.h1 || 0),
      volume24h: Number(pair?.volume?.h24 || 0),
      liquidity: Number(pair?.liquidity?.usd || 0),
      marketCap: Number(pair?.marketCap || 0),
      fdv: Number(pair?.fdv || 0),
      pairCreatedAt: createdAt,
      txns: pair?.txns || {},
      url: pair?.url,
    };
  } catch {
    return null;
  }
}

function passesBasicGates(token) {
  const ageH = getAgeHours(token.pairCreatedAt);
  if (ageH > WATCH_HOURS || getAgeMinutes(token.pairCreatedAt) < MIN_AGE_MINUTES) return false;
  if (token.liquidity < MIN_LIQ_USD || token.volume24h < MIN_VOL_24H_USD) return false;
  if (token.marketCap > 0 && token.marketCap > MAX_MARKETCAP_USD) return false;
  return true;
}

function assessEarlyRisk(token) {
  const risks = [];
  const ageH = getAgeHours(token.pairCreatedAt);
  if (ageH < 1) risks.push("⚡ JUST LAUNCHED");
  if (token.liquidity < 5000) risks.push("🔴 Low Liquidity");
  if (Math.abs(token.priceChange1h) > 100) risks.push("📈 Extreme Volatility");
  const ratio = token.liquidity > 0 ? token.volume24h / token.liquidity : 0;
  if (ratio > 10) risks.push("🔥 High Trade/Liq");
  if (ratio < 0.15) risks.push("⚠️ Low Trade/Liq");
  if (token.marketCap > 0 && token.marketCap < 10000) risks.push("🔴 Very Low MCap");
  return risks;
}

function scoreEarlyGem(token) {
  let score = 0;
  const liq = token.liquidity || 0;
  if (liq >= 5000 && liq <= 50000) score += 35;
  else if (liq >= 3000 && liq <= 100000) score += 28;
  else if (liq >= 2000 && liq <= 200000) score += 20;
  else if (liq >= 1000) score += 10;

  const vol = token.volume24h || 0;
  const ratio = liq > 0 ? vol / liq : 0;
  if (ratio >= 2 && ratio <= 10) score += 25;
  else if (ratio >= 1 && ratio < 2) score += 18;
  else if (ratio > 10 && ratio <= 20) score += 15;
  else if (ratio >= 0.5) score += 10;

  const { buys, sells, total } = getH1Txns(token);
  if (total >= 10) {
    const buyPct = total ? buys / total : 0;
    if (buyPct >= 0.65) score += 20;
    else if (buyPct >= 0.58) score += 15;
    else if (buyPct >= 0.52) score += 10;
    else score += 3;
  } else score += 5;

  const ageM = getAgeMinutes(token.pairCreatedAt);
  if (ageM <= 30) score += 15;
  else if (ageM <= 120) score += 12;
  else if (ageM <= 360) score += 8;
  else if (ageM <= 1440) score += 4;

  const ch1 = token.priceChange1h || 0;
  if (ch1 >= 25) score += 5;
  else if (ch1 >= 10) score += 4;
  else if (ch1 >= 3) score += 2;
  else if (ch1 >= 0) score += 1;

  if (token.marketCap > 0 && token.marketCap < 8000) score = Math.max(0, score - 6);
  return Math.min(100, Math.round(score));
}

function shouldTriggerPumpAlert(current, baseline) {
  if (!baseline) return false;
  if (Number(current.priceChange5m || 0) >= PUMP_5M_PCT) return true;
  const baseVol = Number(baseline.volume24h || 0);
  const curVol = Number(current.volume24h || 0);
  if (baseVol >= 1000 && curVol >= baseVol * PUMP_VOL_MULT) return true;
  const { buys, sells, total } = getH1Txns(current);
  if (total >= PUMP_MIN_H1_TXNS && sells > 0 && buys / sells >= PUMP_BUYSELL_RATIO) return true;
  return false;
}

async function scanSeenForPumps(state) {
  const entries = Object.entries(state.seenTokens || {});
  if (!entries.length) return;
  const sorted = entries
    .map(([addr, meta]) => ({ addr, meta: typeof meta === "number" ? { firstSeenAt: meta } : meta }))
    .sort((a, b) => (b.meta?.firstSeenAt || 0) - (a.meta?.firstSeenAt || 0))
    .slice(0, PUMP_CHECK_LIMIT);
  console.log(`🔁 Pump monitor: ${sorted.length} tokens`);
  for (const { addr, meta } of sorted) {
    if (!meta) continue;
    const refTime = meta.pairCreatedAt || meta.firstSeenAt;
    if (getAgeHours(refTime) > WATCH_HOURS) continue;
    const token = await getTokenDetails(addr, meta.pairAddress || null);
    await sleep(150);
    if (!token) continue;
    meta.lastCheckedAt = Date.now();
    meta.pairCreatedAt = meta.pairCreatedAt || token.pairCreatedAt || null;
    meta.pairAddress = meta.pairAddress || token.pairAddress || null;
    meta.lastKnown = { priceChange5m: token.priceChange5m, priceChange1h: token.priceChange1h, volume24h: token.volume24h, liquidity: token.liquidity };
    if (!meta.baseline) meta.baseline = { price: token.price, volume24h: token.volume24h, liquidity: token.liquidity };
    if (shouldTriggerPumpAlert(token, meta.baseline)) {
      // Hard age floor to avoid dust spikes
      if (getAgeMinutes(token.pairCreatedAt) < MIN_PUMP_AGE_MINUTES) {
        // too fresh
      } else {
        const m5 = getM5Txns(token);
        const h1 = getH1Txns(token);
        const m5Vol = Number(token.volumeM5 || 0);

        // Tier checks (confirmed first)
        const isConfirmed =
          (token.liquidity || 0) >= MIN_PUMP_CONF_LIQ_USD &&
          m5.total >= MIN_PUMP_CONF_M5_TXNS &&
          m5.buys >= MIN_PUMP_CONF_M5_BUYS &&
          m5Vol >= MIN_PUMP_CONF_M5_VOL_USD;

        const isEarly =
          (token.liquidity || 0) >= MIN_PUMP_EARLY_LIQ_USD &&
          m5.total >= MIN_PUMP_EARLY_M5_TXNS &&
          m5.buys >= MIN_PUMP_EARLY_M5_BUYS &&
          m5Vol >= MIN_PUMP_EARLY_M5_VOL_USD;

        if (isConfirmed && canSendCooldown(meta.lastPumpAlertConfirmedAt, PUMP_ALERT_COOLDOWN_HOURS)) {
          meta.lastPumpAlertConfirmedAt = Date.now();
          await postToDiscord({
            title: "✅ CONFIRMED PUMP",
            description: `**${token.symbol}** — ${token.name}`,
            color: 0x00ff00,
            webhookUrl: DISCORD_WEBHOOK_URL_PUMP_CONFIRMED,
            fields: [
              { name: "⏰ Age", value: formatAge(token.pairCreatedAt), inline: true },
              { name: "📈 5m", value: `${token.priceChange5m >= 0 ? '+' : ''}${token.priceChange5m.toFixed(2)}%`, inline: true },
              { name: "📈 1h", value: `${token.priceChange1h >= 0 ? '+' : ''}${token.priceChange1h.toFixed(2)}%`, inline: true },
              { name: "💧 Liq", value: formatCurrency(token.liquidity), inline: true },
              { name: "💸 Vol (5m)", value: formatCurrency(m5Vol), inline: true },
              { name: "🔄 Txns (5m)", value: `${m5.total} (${m5.buys}/${m5.sells})`, inline: true },
              { name: "🔄 Txns (1h)", value: `${h1.total} (${h1.buys}/${h1.sells})`, inline: true },
              { name: "📊 Vol 24h", value: formatCurrency(token.volume24h), inline: true },
              { name: "Token", value: `\`${token.address}\``, inline: false },
              ...(token.url ? [{ name: "Chart", value: token.url, inline: false }] : []),
            ],
          });
          console.log(`🚨 Confirmed pump: ${token.symbol}`);
        } else if (isEarly && canSendCooldown(meta.lastPumpAlertEarlyAt, PUMP_ALERT_COOLDOWN_HOURS)) {
          meta.lastPumpAlertEarlyAt = Date.now();
          await postToDiscord({
            title: "🚀 EARLY PUMP",
            description: `**${token.symbol}** — ${token.name}`,
            color: 0xffa500,
            webhookUrl: DISCORD_WEBHOOK_URL_PUMP_EARLY,
            fields: [
              { name: "⏰ Age", value: formatAge(token.pairCreatedAt), inline: true },
              { name: "📈 5m", value: `${token.priceChange5m >= 0 ? '+' : ''}${token.priceChange5m.toFixed(2)}%`, inline: true },
              { name: "📈 1h", value: `${token.priceChange1h >= 0 ? '+' : ''}${token.priceChange1h.toFixed(2)}%`, inline: true },
              { name: "💧 Liq", value: formatCurrency(token.liquidity), inline: true },
              { name: "💸 Vol (5m)", value: formatCurrency(m5Vol), inline: true },
              { name: "🔄 Txns (5m)", value: `${m5.total} (${m5.buys}/${m5.sells})`, inline: true },
              { name: "🔄 Txns (1h)", value: `${h1.total} (${h1.buys}/${h1.sells})`, inline: true },
              { name: "📊 Vol 24h", value: formatCurrency(token.volume24h), inline: true },
              { name: "Token", value: `\`${token.address}\``, inline: false },
              ...(token.url ? [{ name: "Chart", value: token.url, inline: false }] : []),
            ],
          });
          console.log(`🚨 Early pump: ${token.symbol}`);
        }
      }
    }
    state.seenTokens[addr] = meta;
  }
}

async function scanForGems() {
  console.log(`\n[${new Date().toISOString()}] 🔍 Scanning...`);
  const state = loadState();
  pruneSeen(state, SEEN_TTL_DAYS);
  await scanSeenForPumps(state);
  const candidates = new Map();
  const dexCandidates = await fetchRecentRaydiumPairs();
  for (const c of dexCandidates) candidates.set(c.address, c);
  console.log(`📊 ${candidates.size} candidates, enriching ${Math.min(MAX_ANALYZE, candidates.size)}...`);
  const gems = [];
  const list = Array.from(candidates.values()).slice(0, MAX_ANALYZE);
  for (const c of list) {
    const addr = c.address;
    const metaRaw = state.seenTokens[addr];
    const meta = typeof metaRaw === "number" ? { firstSeenAt: metaRaw } : (metaRaw || {});
    if (!canSendCooldown(meta.lastAlertAt, NEW_ALERT_COOLDOWN_HOURS)) continue;
    const token = await getTokenDetails(addr, c.fromPair?.pairAddress || meta.pairAddress || null);
    await sleep(150);
    if (!token) continue;
    if (!meta.firstSeenAt) meta.firstSeenAt = Date.now();
    if (!meta.pairCreatedAt && token.pairCreatedAt) meta.pairCreatedAt = token.pairCreatedAt;
    if (!meta.pairAddress && token.pairAddress) meta.pairAddress = token.pairAddress;
    if (!meta.baseline) meta.baseline = { price: token.price, volume24h: token.volume24h, liquidity: token.liquidity };
    meta.lastCheckedAt = Date.now();
    if (!passesBasicGates(token)) {
      meta.status = meta.status || "early_watch";
      state.seenTokens[addr] = meta;
      continue;
    }
    token.score = scoreEarlyGem(token);
    token.risks = assessEarlyRisk(token);
    gems.push(token);
    meta.status = "qualified";
    state.seenTokens[addr] = meta;
    console.log(`  💎 ${token.symbol} | ${token.score} | ${formatCurrency(token.liquidity)}`);
  }
  state.lastRun = new Date().toISOString();
  saveState(state);
  if (!gems.length) {
    console.log("No qualifying gems.");
    return;
  }
  gems.sort((a, b) => b.score - a.score);
  const top = gems.slice(0, ALERT_TOP_N);
  console.log(`🚀 Alerting ${top.length} gems...`);
  for (const gem of top) {
    const ageH = getAgeHours(gem.pairCreatedAt);
    let color = 0x00ff00;
    if (gem.score < 55) color = 0xffa500;
    if (gem.score < 40) color = 0x808080;
    if (ageH < 1) color = 0xaa00ff;
    let title = gem.score >= 75 ? "🚀 HIGH POTENTIAL GEM" : ageH < 1 ? "⚡ JUST LAUNCHED" : "💎 New Gem";
    if (ageH < 0.5 && gem.score >= 70 && gem.liquidity >= 5000) {
      title = "🚨 ULTRA EARLY!";
      color = 0xff0000;
    }
    const { buys, sells, total } = getH1Txns(gem);
    const fields = [
      { name: "💎 Score", value: `**${gem.score}/100**`, inline: true },
      { name: "⏰ Age", value: formatAge(gem.pairCreatedAt), inline: true },
      { name: "💰 Price", value: formatPrice(gem.price), inline: true },
      { name: "💧 Liq", value: formatCurrency(gem.liquidity), inline: true },
      { name: "📊 Vol", value: formatCurrency(gem.volume24h), inline: true },
      { name: "🔄 Txns", value: `${total} (${buys}/${sells})`, inline: true },
      { name: "📈 5m", value: `${gem.priceChange5m >= 0 ? '+' : ''}${gem.priceChange5m.toFixed(2)}%`, inline: true },
      { name: "📈 1h", value: `${gem.priceChange1h >= 0 ? '+' : ''}${gem.priceChange1h.toFixed(2)}%`, inline: true },
      { name: "🏷️ MCap", value: gem.marketCap > 0 ? formatCurrency(gem.marketCap) : "n/a", inline: true },
    ];
    if (gem.risks?.length) fields.push({ name: "⚠️ Risks", value: gem.risks.slice(0, 5).join("\n"), inline: false });
    fields.push({ name: "Token", value: `\`${gem.address}\``, inline: false });
    if (gem.pairAddress) fields.push({ name: "Pair", value: `\`${gem.pairAddress}\``, inline: false });
    if (gem.url) fields.push({ name: "Chart", value: gem.url, inline: false });
    await postToDiscord({ title, description: `**${gem.symbol}** — ${gem.name}`, fields, color });
    const st = loadState();
    const m = typeof st.seenTokens[gem.address] === "number" ? { firstSeenAt: st.seenTokens[gem.address] } : (st.seenTokens[gem.address] || {});
    m.lastAlertAt = Date.now();
    m.status = "alerted";
    m.pairCreatedAt = m.pairCreatedAt || gem.pairCreatedAt || null;
    m.pairAddress = m.pairAddress || gem.pairAddress || null;
    if (!m.baseline) m.baseline = { price: gem.price, volume24h: gem.volume24h, liquidity: gem.liquidity };
    st.seenTokens[gem.address] = m;
    saveState(st);
    console.log(`  ✅ ${gem.symbol}`);
    await sleep(250);
  }
}


// ---------- Trending (DexScreener "what's hot" + our own marketcap/FDV deltas) ----------
/**
 * Adds "trending" alerts even for older tokens:
 * - Discover candidates from DexScreener public feeds (boosts/profiles).
 * - Put them into a watchlist (up to WATCH_DAYS).
 * - Snapshot cap/liquidity/txns periodically and alert on acceleration.
 *
 * Controls (env):
 *   TRENDING_ENABLED=1|0
 *   TREND_MAX_WATCH=100
 *   TREND_WINDOW_MIN=15
 *   TREND_PCT_THRESHOLD=25
 *   TREND_MIN_LIQ_USD=5000
 *   TREND_MIN_VOL_24H_USD=5000
 *   TREND_MIN_TXNS_1H=25
 *   TREND_ALERT_COOLDOWN_MIN=45
 *   TREND_HISTORY_MAX=120
 */

const TRENDING_ENABLED = process.env.TRENDING_ENABLED !== "0";

// Public feeds (no API key)
const DEX_TREND_BOOSTS_TOP = "https://api.dexscreener.com/token-boosts/top/v1";
const DEX_TREND_BOOSTS_LATEST = "https://api.dexscreener.com/token-boosts/latest/v1";
const DEX_TREND_PROFILES_LATEST = "https://api.dexscreener.com/token-profiles/latest/v1";

const TREND_MAX_WATCH = Number(process.env.TREND_MAX_WATCH || 100);
const TREND_WINDOW_MIN = Number(process.env.TREND_WINDOW_MIN || 15);
const TREND_PCT_THRESHOLD = Number(process.env.TREND_PCT_THRESHOLD || 25);

const TREND_MIN_LIQ_USD = Number(process.env.TREND_MIN_LIQ_USD || 5000);
const TREND_MIN_VOL_24H_USD = Number(process.env.TREND_MIN_VOL_24H_USD || 5000);
const TREND_MIN_TXNS_1H = Number(process.env.TREND_MIN_TXNS_1H || 25);

const TREND_ALERT_COOLDOWN_MIN = Number(process.env.TREND_ALERT_COOLDOWN_MIN || 45);
const TREND_HISTORY_MAX = Number(process.env.TREND_HISTORY_MAX || 120);

function ensureWatchState(st) {
  if (!st.watch) st.watch = {}; // tokenAddr -> { addedAt, lastTrendAlertAt, history: [], reason }
  return st.watch;
}

function pruneWatch(st) {
  const watch = ensureWatchState(st);
  const cutoff = Date.now() - WATCH_DAYS * 24 * 60 * 60 * 1000;
  let pruned = 0;

  for (const [addr, item] of Object.entries(watch)) {
    const addedAt = Number(item?.addedAt || 0);
    if (!addedAt || addedAt < cutoff) {
      delete watch[addr];
      pruned++;
    }
  }
  if (pruned) console.log(`  🧹 Trending: pruned ${pruned} old watch tokens (>${WATCH_DAYS}d)`);
}

function addToWatch(st, tokenAddr, reason = "dex-trending") {
  if (!tokenAddr) return;
  const watch = ensureWatchState(st);
  if (!watch[tokenAddr]) {
    watch[tokenAddr] = { addedAt: Date.now(), lastTrendAlertAt: 0, history: [], reason };
  }
}

function normalizeTokenAddr(item) {
  return (
    item?.tokenAddress ||
    item?.address ||
    item?.baseToken?.address ||
    item?.token?.address ||
    item?.token?.tokenAddress ||
    null
  );
}

function isSolanaItem(item) {
  const chain =
    item?.chainId ||
    item?.chain ||
    item?.network ||
    item?.token?.chainId ||
    item?.token?.chain ||
    null;

  // Many feeds omit chain; treat missing as "ok"
  return !chain || String(chain).toLowerCase() === "solana";
}

async function fetchTrendingCandidates() {
  const out = new Set();

  const feeds = [
    { url: DEX_TREND_BOOSTS_TOP, label: "boosts/top" },
    { url: DEX_TREND_BOOSTS_LATEST, label: "boosts/latest" },
    { url: DEX_TREND_PROFILES_LATEST, label: "profiles/latest" },
  ];

  for (const f of feeds) {
    try {
      const res = await fetch(f.url);
      if (!res.ok) {
        console.log(`  ⚠️ Trending feed ${f.label}: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();

      const items = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
      for (const it of items) {
        if (!isSolanaItem(it)) continue;
        const addr = normalizeTokenAddr(it);
        if (addr) out.add(addr);
      }
    } catch (e) {
      console.log(`  ⚠️ Trending feed error (${f.label}): ${e.message}`);
    }
    await sleep(150);
  }

  return Array.from(out).slice(0, 120);
}

function baseCap(token) {
  const mc = Number(token?.marketCap || 0);
  const fdv = Number(token?.fdv || 0);
  return mc > 0 ? mc : fdv > 0 ? fdv : 0;
}

function pctUp(from, to) {
  if (!from || from <= 0) return 0;
  return ((to - from) / from) * 100;
}

function txns1h(token) {
  const h1 = token?.txns?.h1 || {};
  const buys = Number(h1.buys || 0);
  const sells = Number(h1.sells || 0);
  return { buys, sells, total: buys + sells };
}

function findBaseline(history, targetTs) {
  // history is sorted ascending by ts
  let baseline = null;
  for (let i = 0; i < history.length; i++) {
    if (history[i]?.ts <= targetTs) baseline = history[i];
    else break;
  }
  return baseline;
}

function shouldTrendAlert(watchItem, token) {
  const now = Date.now();
  const cooldownMs = TREND_ALERT_COOLDOWN_MIN * 60 * 1000;
  if (watchItem.lastTrendAlertAt && (now - watchItem.lastTrendAlertAt) < cooldownMs) return null;

  const capNow = baseCap(token);
  if (!capNow) return null;

  const liq = Number(token?.liquidity || 0);
  const vol24 = Number(token?.volume24h || 0);
  const { total: t1h } = txns1h(token);

  if (liq < TREND_MIN_LIQ_USD) return null;
  if (vol24 < TREND_MIN_VOL_24H_USD) return null;
  if (t1h < TREND_MIN_TXNS_1H) return null;

  const windowMs = TREND_WINDOW_MIN * 60 * 1000;
  const hist = Array.isArray(watchItem.history) ? watchItem.history : [];
  if (hist.length < 2) return null;

  const baseline = findBaseline(hist, now - windowMs);
  if (!baseline?.cap) return null;

  const pct = pctUp(Number(baseline.cap), capNow);
  if (pct < TREND_PCT_THRESHOLD) return null;

  return { pct, capThen: Number(baseline.cap), capNow, liq, vol24, t1h };
}

async function runTrendingTick() {
  if (!TRENDING_ENABLED) return;

  console.log("📈 Trending tick...");

  const st = loadState();
  pruneSeen(st, SEEN_TTL_DAYS);
  pruneWatch(st);

  // 1) Discover trending candidates
  const addrs = await fetchTrendingCandidates();
  console.log(`  Trending discovery: ${addrs.length} candidates`);
  for (const a of addrs) addToWatch(st, a, "dex-trending");

  // 2) Monitor watchlist
  const watch = ensureWatchState(st);
  const list = Object.keys(watch).slice(0, TREND_MAX_WATCH);
  console.log(`  Trending watchlist: ${list.length} tokens`);

  let checked = 0;
  let alerted = 0;

  for (const addr of list) {
    const item = watch[addr];

    const token = await getTokenDetails(addr);
    await sleep(220);
    checked++;

    if (!token) continue;

    const cap = baseCap(token);
    const snap = {
      ts: Date.now(),
      cap,
      liq: Number(token.liquidity || 0),
      vol24: Number(token.volume24h || 0),
      ch1: Number(token.priceChange1h || 0),
      price: Number(token.price || 0),
    };

    if (!Array.isArray(item.history)) item.history = [];
    item.history.push(snap);
    item.history.sort((a, b) => a.ts - b.ts);
    if (item.history.length > TREND_HISTORY_MAX) item.history = item.history.slice(-TREND_HISTORY_MAX);

    const verdict = shouldTrendAlert(item, token);
    if (!verdict) continue;

    item.lastTrendAlertAt = Date.now();
    alerted++;

    const { buys, sells, total } = txns1h(token);
    const capLabel = (Number(token.marketCap || 0) > 0) ? "MCap" : "FDV";

    const fields = [
      { name: "📈 Trend", value: `**+${verdict.pct.toFixed(1)}%** / ${TREND_WINDOW_MIN}m`, inline: true },
      { name: `🏷️ ${capLabel}`, value: formatCurrency(verdict.capNow), inline: true },
      { name: "💧 Liquidity", value: formatCurrency(verdict.liq), inline: true },
      { name: "📊 Vol 24h", value: formatCurrency(verdict.vol24), inline: true },
      { name: "🔄 Txns (1h)", value: `${total} (B:${buys}/S:${sells})`, inline: true },
      { name: "📈 1h %", value: `${token.priceChange1h >= 0 ? "+" : ""}${token.priceChange1h.toFixed(2)}%`, inline: true },
      { name: "Token", value: `\`${token.address}\``, inline: false },
    ];
    if (token.url) fields.push({ name: "📊 Chart", value: token.url, inline: false });

    await postToDiscord({
      title: "📈 TRENDING UP (MCap/FDV)",
      description: `**${token.symbol}** — ${token.name}\nAccelerating ${capLabel} over last ${TREND_WINDOW_MIN} minutes.`,
      fields,
      color: 0x00b7ff,
    });

    console.log(`  ✅ Trending alert sent: ${token.symbol} (+${verdict.pct.toFixed(1)}%/${TREND_WINDOW_MIN}m)`);
    await sleep(350);
  }

  saveState(st);
  console.log(`  Trending done: checked ${checked}, alerted ${alerted}`);
}

// ---------- Early Move + Confirmed Pump (solves "late alerts") ----------
const EARLY_MOVE_ENABLED = process.env.EARLY_MOVE_ENABLED !== "0";
const EARLY_MOVE_5M_PCT = Number(process.env.EARLY_MOVE_5M_PCT || 2);
const EARLY_MOVE_1H_PCT = Number(process.env.EARLY_MOVE_1H_PCT || 5);
const EARLY_MOVE_MIN_LIQ = Number(process.env.EARLY_MOVE_MIN_LIQ || 1000);
const EARLY_MOVE_MIN_TXNS_1H = Number(process.env.EARLY_MOVE_MIN_TXNS_1H || 20);
const EARLY_MOVE_MIN_VOL_24H = Number(process.env.EARLY_MOVE_MIN_VOL_24H || 2500);
const EARLY_ALERT_COOLDOWN_MIN = Number(process.env.EARLY_ALERT_COOLDOWN_MIN || 30);

const PUMP_ENABLED = process.env.PUMP_ENABLED !== "0";
const PUMP_5M_PCT = Number(process.env.PUMP_5M_PCT || 6);
const PUMP_1H_PCT = Number(process.env.PUMP_1H_PCT || 20);
const PUMP_MIN_LIQ = Number(process.env.PUMP_MIN_LIQ || 10000);
const PUMP_MIN_TXNS_1H = Number(process.env.PUMP_MIN_TXNS_1H || 40);
const PUMP_MIN_VOL_24H = Number(process.env.PUMP_MIN_VOL_24H || 10000);
const PUMP_ALERT_COOLDOWN_MIN = Number(process.env.PUMP_ALERT_COOLDOWN_MIN || 45);

function ensurePumpState(st) {
  if (!st.pumps) st.pumps = {}; // token -> { lastEarlyAt, lastPumpAt }
  return st.pumps;
}

function pumpCooldownOk(lastAt, min) {
  if (!lastAt) return true;
  return (Date.now() - lastAt) > (min * 60 * 1000);
}

function meetsEarlyMove(token) {
  const liq = Number(token.liquidity || 0);
  const vol24 = Number(token.volume24h || 0);
  const ch5 = Number(token.priceChange5m || 0);
  const ch1 = Number(token.priceChange1h || 0);
  const { total: t1h } = txns1h(token);

  if (liq < EARLY_MOVE_MIN_LIQ) return false;
  if (vol24 < EARLY_MOVE_MIN_VOL_24H) return false;
  if (t1h < EARLY_MOVE_MIN_TXNS_1H) return false;

  return (ch5 >= EARLY_MOVE_5M_PCT) || (ch1 >= EARLY_MOVE_1H_PCT);
}

function meetsConfirmedPump(token) {
  const liq = Number(token.liquidity || 0);
  const vol24 = Number(token.volume24h || 0);
  const ch5 = Number(token.priceChange5m || 0);
  const ch1 = Number(token.priceChange1h || 0);
  const { total: t1h } = txns1h(token);

  if (liq < PUMP_MIN_LIQ) return false;
  if (vol24 < PUMP_MIN_VOL_24H) return false;
  if (t1h < PUMP_MIN_TXNS_1H) return false;

  return (ch5 >= PUMP_5M_PCT) && (ch1 >= PUMP_1H_PCT);
}

async function runPumpMonitorsTick(st) {
  if (!EARLY_MOVE_ENABLED && !PUMP_ENABLED) return;

  const watch = ensureWatchState(st);
  const pumps = ensurePumpState(st);

  const list = Object.keys(watch).slice(0, Math.max(TREND_MAX_WATCH, 100));
  console.log(`📟 Pump monitor: ${list.length} tokens`);

  let earlySent = 0;
  let pumpSent = 0;

  for (const addr of list) {
    const token = await getTokenDetails(addr);
    await sleep(200);
    if (!token) continue;

    if (!pumps[addr]) pumps[addr] = { lastEarlyAt: 0, lastPumpAt: 0 };

    if (EARLY_MOVE_ENABLED && pumpCooldownOk(pumps[addr].lastEarlyAt, EARLY_ALERT_COOLDOWN_MIN) && meetsEarlyMove(token)) {
      pumps[addr].lastEarlyAt = Date.now();
      earlySent++;

      const { buys, sells, total } = txns1h(token);
      const fields = [
        { name: "⏰ Age", value: formatAge(token.pairCreatedAt), inline: true },
        { name: "📈 5m", value: `${token.priceChange5m >= 0 ? "+" : ""}${Number(token.priceChange5m).toFixed(2)}%`, inline: true },
        { name: "📈 1h", value: `${token.priceChange1h >= 0 ? "+" : ""}${Number(token.priceChange1h).toFixed(2)}%`, inline: true },
        { name: "💧 Liq", value: formatCurrency(token.liquidity), inline: true },
        { name: "📊 Vol 24h", value: formatCurrency(token.volume24h), inline: true },
        { name: "🔄 Txns (1h)", value: `${total} (B:${buys}/S:${sells})`, inline: true },
        { name: "Token", value: `\`${token.address}\``, inline: false },
      ];
      if (token.url) fields.push({ name: "📊 Chart", value: token.url, inline: false });

      await postToDiscord({
        title: "🚨 EARLY MOVE ALERT",
        description: `**${token.symbol}** — ${token.name}\nEarly momentum detected (baseline-free).`,
        fields,
        color: 0xf1c40f,
      });

      console.log(`  🚨 Early move alert: ${token.symbol}`);
      await sleep(250);
    }

    if (PUMP_ENABLED && pumpCooldownOk(pumps[addr].lastPumpAt, PUMP_ALERT_COOLDOWN_MIN) && meetsConfirmedPump(token)) {
      pumps[addr].lastPumpAt = Date.now();
      pumpSent++;

      const { buys, sells, total } = txns1h(token);
      const fields = [
        { name: "⏰ Age", value: formatAge(token.pairCreatedAt), inline: true },
        { name: "📈 5m", value: `${token.priceChange5m >= 0 ? "+" : ""}${Number(token.priceChange5m).toFixed(2)}%`, inline: true },
        { name: "📈 1h", value: `${token.priceChange1h >= 0 ? "+" : ""}${Number(token.priceChange1h).toFixed(2)}%`, inline: true },
        { name: "💧 Liq", value: formatCurrency(token.liquidity), inline: true },
        { name: "📊 Vol 24h", value: formatCurrency(token.volume24h), inline: true },
        { name: "🔄 Txns (1h)", value: `${total} (B:${buys}/S:${sells})`, inline: true },
        { name: "Token", value: `\`${token.address}\``, inline: false },
      ];
      if (token.url) fields.push({ name: "📊 Chart", value: token.url, inline: false });

      await postToDiscord({
        title: "📈 PUMP ALERT!",
        description: `**${token.symbol}** — ${token.name}\nConfirmed pump conditions met.`,
        fields,
        color: 0xe74c3c,
      });

      console.log(`  📈 Pump alert: ${token.symbol}`);
      await sleep(250);
    }
  }

  console.log(`📟 Pump monitor done: early=${earlySent}, pump=${pumpSent}`);
}

(async () => {
  if (process.env.SEED_ONLY === "1") {
    const st = loadState();
    pruneSeen(st, SEEN_TTL_DAYS);
    st.lastRun = new Date().toISOString();
    saveState(st);
    console.log("State ready.");
    process.exit(0);
  }
  console.log("💎🚀 RAYDIUM MEME HUNTER 🚀💎");
  console.log("=".repeat(60));
  console.log(`Poll: ${POLL_MS / 1000}s | Window: ${MIN_AGE_MINUTES}m-${MAX_AGE_HOURS}h | Watch: ${WATCH_DAYS}d`);
  console.log("=".repeat(60));
  const tick = async () => {
    // 1) Gems discovery (new pools / candidates)
    await scanForGems().catch(e => console.error("Gems error:", e));

    // 2) Trending discovery + cap/FDV acceleration (older coins included)
    await runTrendingTick().catch(e => console.error("Trending error:", e));

    // 3) Baseline-free early move + confirmed pump alerts over the watchlist
    const st = loadState();
    const watchSize = Object.keys(st.watch || {}).length;
    const seenSize = Object.keys(st.seenTokens || {}).length;
    await runPumpMonitorsTick(st).catch(e => console.error("Pump error:", e));
    saveState(st);

    // 4) Heartbeat (confirms uptime + helps debug "missed" moves)
    await maybeHeartbeat({ watchSize, seenSize }).catch(() => {});
  };
  await tick();
  setInterval(() => tick().catch(e => console.error("Tick error:", e)), POLL_MS);
})();

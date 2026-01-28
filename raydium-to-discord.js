/**
 * Raydium Meme Hunter (Solana) — Discord alerts
 *
 * FINAL VERSION - ALL FIXES INCLUDED:
 * ✅ Poll default = 60s (faster scanning)
 * ✅ MAX_AGE_HOURS = 168 (7 days for more coverage)
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
const POLL_MS = Number(process.env.POLL_MS || 60000);
const MAX_ANALYZE = Number(process.env.MAX_ANALYZE || 40);
const ALERT_TOP_N = Number(process.env.ALERT_TOP_N || 10);
const MAX_AGE_HOURS = Number(process.env.MAX_AGE_HOURS || 168);
const MIN_AGE_MINUTES = Number(process.env.MIN_AGE_MINUTES || 5);
const WATCH_DAYS = Number(process.env.WATCH_DAYS || 3);
const WATCH_HOURS = WATCH_DAYS * 24;
const PUMP_CHECK_LIMIT = Number(process.env.PUMP_CHECK_LIMIT || 100);
const MIN_LIQ_USD = Number(process.env.MIN_LIQ_USD || 2500);
const MIN_VOL_24H_USD = Number(process.env.MIN_VOL_24H_USD || 1500);
const MAX_MARKETCAP_USD = Number(process.env.MAX_MARKETCAP_USD || 5_000_000);
const SEEN_TTL_DAYS = Number(process.env.SEEN_TTL_DAYS || 14);
const NEW_ALERT_COOLDOWN_HOURS = Number(process.env.NEW_ALERT_COOLDOWN_HOURS || 12);
const PUMP_ALERT_COOLDOWN_HOURS = Number(process.env.PUMP_ALERT_COOLDOWN_HOURS || 6);
const PUMP_5M_PCT = Number(process.env.PUMP_5M_PCT || 25);
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
    if (!canSendCooldown(meta.lastPumpAlertAt, PUMP_ALERT_COOLDOWN_HOURS)) continue;
    const token = await getTokenDetails(addr, meta.pairAddress || null);
    await sleep(150);
    if (!token) continue;
    meta.lastCheckedAt = Date.now();
    meta.pairCreatedAt = meta.pairCreatedAt || token.pairCreatedAt || null;
    meta.pairAddress = meta.pairAddress || token.pairAddress || null;
    meta.lastKnown = { priceChange5m: token.priceChange5m, priceChange1h: token.priceChange1h, volume24h: token.volume24h, liquidity: token.liquidity };
    if (!meta.baseline) meta.baseline = { price: token.price, volume24h: token.volume24h, liquidity: token.liquidity };
    if (shouldTriggerPumpAlert(token, meta.baseline)) {
      meta.lastPumpAlertAt = Date.now();
      const { buys, sells, total } = getH1Txns(token);
      const ratio = sells > 0 ? (buys / sells).toFixed(2) : "∞";
      await postToDiscord({
        title: "📈 PUMP ALERT!",
        description: `**${token.symbol}** — ${token.name}`,
        color: 0xff0000,
        fields: [
          { name: "⏰ Age", value: formatAge(token.pairCreatedAt), inline: true },
          { name: "📈 5m", value: `${token.priceChange5m >= 0 ? '+' : ''}${token.priceChange5m.toFixed(2)}%`, inline: true },
          { name: "📈 1h", value: `${token.priceChange1h >= 0 ? '+' : ''}${token.priceChange1h.toFixed(2)}%`, inline: true },
          { name: "💧 Liq", value: formatCurrency(token.liquidity), inline: true },
          { name: "📊 Vol", value: formatCurrency(token.volume24h), inline: true },
          { name: "🔄 B/S", value: `${total} (${buys}/${sells}) R:${ratio}`, inline: true },
          { name: "Token", value: `\`${token.address}\``, inline: false },
          ...(token.url ? [{ name: "Chart", value: token.url, inline: false }] : []),
        ],
      });
      console.log(`🚨 Pump: ${token.symbol}`);
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
  await scanForGems().catch(e => console.error("Error:", e));
  setInterval(() => scanForGems().catch(e => console.error("Error:", e)), POLL_MS);
})();

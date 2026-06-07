// ================================================
// KRAKEN TRADING BOT - SISTEMA ADATTIVO
// Agenti: Entry | Position Manager | Reserve
// Notifiche Telegram | Machine Learning
// ================================================

const ccxt = require('ccxt');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
require('dotenv').config();

// ================================================
// CONFIGURAZIONE
// ================================================
const CONFIG = {
  kraken: {
    apiKey: process.env.KRAKEN_API_KEY,
    secret: process.env.KRAKEN_SECRET,
  },
  telegram: {
    token: process.env.TELEGRAM_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },
  trading: {
    capitalTotal: 100,
    capitalEntry: 50,      // 50% del capitale per i trade
    capitalReserve: 15,    // 15% sempre in riserva
    pairs: ['SOL/EUR', 'DOGE/EUR', 'XRP/EUR', 'LINK/EUR'],
    takeProfitPercent: 12,
    stopLossPercent: 8,
    rsiThreshold: 30,
    volumeMultiplier: 2,
    checkIntervalMs: 4 * 60 * 60 * 1000, // ogni 4 ore
    maxDailyLosses: 2,
  },
  learning: {
    dataFile: './trade_history.json',
    maxFailedSignals: 3,   // dopo 3 fallimenti, ignora segnale per 24h
    adaptationInterval: 5, // adatta strategia ogni 5 trade
  }
};

// ================================================
// INIZIALIZZAZIONE
// ================================================
const exchange = new ccxt.kraken({
  apiKey: CONFIG.kraken.apiKey,
  secret: CONFIG.kraken.secret,
  enableRateLimit: true,
});

const telegram = new TelegramBot(CONFIG.telegram.token, { polling: false });

// Memoria del bot (machine learning)
let botMemory = {
  trades: [],
  failedSignals: {},
  dailyLosses: 0,
  lastLossDate: null,
  adaptedParams: {
    rsiThreshold: CONFIG.trading.rsiThreshold,
    volumeMultiplier: CONFIG.trading.volumeMultiplier,
    stopLossPercent: CONFIG.trading.stopLossPercent,
    takeProfitPercent: CONFIG.trading.takeProfitPercent,
  }
};

// ================================================
// UTILITY: NOTIFICHE TELEGRAM
// ================================================
async function sendTelegram(message) {
  try {
    await telegram.sendMessage(CONFIG.telegram.chatId, message, { parse_mode: 'Markdown' });
    console.log('[TELEGRAM]', message);
  } catch (err) {
    console.error('[TELEGRAM ERROR]', err.message);
  }
}

// ================================================
// UTILITY: SALVA/CARICA MEMORIA
// ================================================
function saveMemory() {
  fs.writeFileSync(CONFIG.learning.dataFile, JSON.stringify(botMemory, null, 2));
}

function loadMemory() {
  if (fs.existsSync(CONFIG.learning.dataFile)) {
    const data = fs.readFileSync(CONFIG.learning.dataFile, 'utf8');
    botMemory = JSON.parse(data);
    console.log('[MEMORY] Caricata memoria precedente');
  }
}

// ================================================
// UTILITY: CALCOLO RSI (14 periodi)
// ================================================
function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ================================================
// UTILITY: CALCOLO VOLUME MEDIO
// ================================================
function calculateAverageVolume(candles) {
  const volumes = candles.map(c => c[5]);
  return volumes.reduce((a, b) => a + b, 0) / volumes.length;
}

// ================================================
// AGENTE 1: ENTRY
// Monitora segnali e decide quando entrare
// ================================================
async function agentEntry() {
  console.log('\n[ENTRY AGENT] Controllo segnali di ingresso...');

  // Controlla limite perdite giornaliere
  const today = new Date().toDateString();
  if (botMemory.lastLossDate === today && botMemory.dailyLosses >= CONFIG.trading.maxDailyLosses) {
    console.log('[ENTRY AGENT] Limite perdite giornaliere raggiunto. Stop per oggi.');
    await sendTelegram('⛔ *STOP TRADING*\nRaggiunto limite perdite giornaliere. Riprendo domani.');
    return;
  }

  for (const pair of CONFIG.trading.pairs) {
    try {
      // Controlla se segnale è in blacklist
      if (isSignalBlacklisted(pair)) {
        console.log(`[ENTRY AGENT] ${pair} in blacklist, salto.`);
        continue;
      }

      // Carica candele 4H
      const candles = await exchange.fetchOHLCV(pair, '4h', undefined, 50);
      if (!candles || candles.length < 20) continue;

      const closePrices = candles.map(c => c[4]);
      const currentPrice = closePrices[closePrices.length - 1];
      const currentVolume = candles[candles.length - 1][5];
      const avgVolume = calculateAverageVolume(candles.slice(0, -1));
      const rsi = calculateRSI(closePrices);

      console.log(`[ENTRY AGENT] ${pair} | Prezzo: ${currentPrice} | RSI: ${rsi.toFixed(2)} | Volume: ${(currentVolume / avgVolume).toFixed(2)}x`);

      // === SEGNALE DI INGRESSO ===
      const rsiOversold = rsi < botMemory.adaptedParams.rsiThreshold;
      const volumeSpike = currentVolume > (avgVolume * botMemory.adaptedParams.volumeMultiplier);

      if (rsiOversold && volumeSpike) {
        console.log(`[ENTRY AGENT] ✅ SEGNALE TROVATO per ${pair}`);
        await executeBuy(pair, currentPrice, rsi, currentVolume / avgVolume);
      }

    } catch (err) {
      console.error(`[ENTRY AGENT] Errore su ${pair}:`, err.message);
    }
  }
}

// ================================================
// AGENTE 2: POSITION MANAGER
// Controlla posizioni aperte, gestisce TP e SL
// ================================================
async function agentPositionManager() {
  console.log('\n[POSITION MANAGER] Controllo posizioni aperte...');

  const openTrades = botMemory.trades.filter(t => t.status === 'open');
  if (openTrades.length === 0) {
    console.log('[POSITION MANAGER] Nessuna posizione aperta.');
    return;
  }

  for (const trade of openTrades) {
    try {
      const ticker = await exchange.fetchTicker(trade.pair);
      const currentPrice = ticker.last;
      const profitPercent = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;

      console.log(`[POSITION MANAGER] ${trade.pair} | Profit: ${profitPercent.toFixed(2)}%`);

      // === TAKE PROFIT ===
      if (profitPercent >= botMemory.adaptedParams.takeProfitPercent) {
        await executeSell(trade, currentPrice, 'TAKE_PROFIT', profitPercent);
      }

      // === STOP LOSS ===
      else if (profitPercent <= -botMemory.adaptedParams.stopLossPercent) {
        await executeSell(trade, currentPrice, 'STOP_LOSS', profitPercent);
      }

      // === BREAKEVEN (se +8%, sposta SL a 0%) ===
      else if (profitPercent >= 8 && !trade.stopMovedToBreakeven) {
        trade.stopMovedToBreakeven = true;
        saveMemory();
        await sendTelegram(`🔒 *BREAKEVEN* su ${trade.pair}\nStop loss spostato a breakeven. Profit attuale: +${profitPercent.toFixed(2)}%`);
      }

    } catch (err) {
      console.error(`[POSITION MANAGER] Errore su ${trade.pair}:`, err.message);
    }
  }
}

// ================================================
// AGENTE 3: RESERVE
// Gestisce il capitale di riserva
// ================================================
async function agentReserve() {
  console.log('\n[RESERVE AGENT] Controllo riserva...');

  try {
    const balance = await exchange.fetchBalance();
    const eurBalance = balance.EUR ? balance.EUR.free : 0;
    console.log(`[RESERVE AGENT] Saldo EUR disponibile: €${eurBalance.toFixed(2)}`);

    // Controlla mercato generale (BTC come indicatore)
    const btcTicker = await exchange.fetchTicker('BTC/EUR');
    const btcCandles = await exchange.fetchOHLCV('BTC/EUR', '4h', undefined, 20);
    const btcPrices = btcCandles.map(c => c[4]);
    const btcRSI = calculateRSI(btcPrices);

    console.log(`[RESERVE AGENT] BTC RSI: ${btcRSI.toFixed(2)}`);

    // Se mercato generale è estremo oversold, segnala opportunità per riserva
    if (btcRSI < 20 && eurBalance >= CONFIG.trading.capitalReserve) {
      await sendTelegram(`💰 *RISERVA PRONTA*\nBTC RSI: ${btcRSI.toFixed(2)} (forte oversold)\nCapitale riserva disponibile per opportunità straordinarie.`);
    }

  } catch (err) {
    console.error('[RESERVE AGENT] Errore:', err.message);
  }
}

// ================================================
// MACHINE LEARNING: ANALISI ERRORI
// ================================================
function analyzeErrors() {
  const closedTrades = botMemory.trades.filter(t => t.status === 'closed');
  if (closedTrades.length < CONFIG.learning.adaptationInterval) return;

  const recentTrades = closedTrades.slice(-CONFIG.learning.adaptationInterval);
  const wins = recentTrades.filter(t => t.profitPercent > 0).length;
  const losses = recentTrades.filter(t => t.profitPercent <= 0).length;
  const winRate = wins / recentTrades.length;

  console.log(`\n[ML] Analisi ultimi ${recentTrades.length} trade: Win rate ${(winRate * 100).toFixed(1)}%`);

  // Adatta i parametri in base ai risultati
  if (winRate < 0.4) {
    // Win rate basso: irrigidisci i filtri di ingresso
    botMemory.adaptedParams.rsiThreshold = Math.max(20, botMemory.adaptedParams.rsiThreshold - 2);
    botMemory.adaptedParams.volumeMultiplier = Math.min(3, botMemory.adaptedParams.volumeMultiplier + 0.2);
    console.log('[ML] Filtri di ingresso inaspriti (troppi falsi segnali)');
  } else if (winRate > 0.7) {
    // Win rate alto: allarga leggermente i filtri
    botMemory.adaptedParams.rsiThreshold = Math.min(35, botMemory.adaptedParams.rsiThreshold + 1);
    botMemory.adaptedParams.volumeMultiplier = Math.max(1.5, botMemory.adaptedParams.volumeMultiplier - 0.1);
    console.log('[ML] Filtri allargati (strategia performante)');
  }

  // Controlla segnali falliti ripetuti per pair
  for (const pair of CONFIG.trading.pairs) {
    const pairTrades = recentTrades.filter(t => t.pair === pair && t.profitPercent <= 0);
    if (pairTrades.length >= CONFIG.learning.maxFailedSignals) {
      const blacklistUntil = Date.now() + (24 * 60 * 60 * 1000);
      botMemory.failedSignals[pair] = blacklistUntil;
      console.log(`[ML] ${pair} in blacklist per 24 ore (${pairTrades.length} fallimenti consecutivi)`);
      sendTelegram(`🚫 *BLACKLIST*: ${pair} escluso per 24h\nMotivo: ${pairTrades.length} trade negativi consecutivi\n[ML ha adattato la strategia]`);
    }
  }

  saveMemory();

  // Report Telegram
  sendTelegram(
    `🤖 *REPORT MACHINE LEARNING*\n` +
    `Win rate: ${(winRate * 100).toFixed(1)}%\n` +
    `RSI soglia adattato: ${botMemory.adaptedParams.rsiThreshold}\n` +
    `Volume multiplier: ${botMemory.adaptedParams.volumeMultiplier.toFixed(1)}x\n` +
    `TP: ${botMemory.adaptedParams.takeProfitPercent}% | SL: ${botMemory.adaptedParams.stopLossPercent}%`
  );
}

// ================================================
// CONTROLLA BLACKLIST SEGNALI
// ================================================
function isSignalBlacklisted(pair) {
  if (!botMemory.failedSignals[pair]) return false;
  if (Date.now() > botMemory.failedSignals[pair]) {
    delete botMemory.failedSignals[pair];
    saveMemory();
    return false;
  }
  return true;
}

// ================================================
// ESEGUI ACQUISTO
// ================================================
async function executeBuy(pair, price, rsi, volumeRatio) {
  try {
    const capitalPerTrade = CONFIG.trading.capitalEntry / CONFIG.trading.pairs.length;
    const amount = capitalPerTrade / price;

    console.log(`[BUY] ${pair} | Prezzo: ${price} | Quantità: ${amount.toFixed(6)}`);

    // Ordine reale su Kraken (commenta per test)
    // const order = await exchange.createLimitBuyOrder(pair, amount, price);

    // Registra il trade nella memoria
    const trade = {
      id: Date.now(),
      pair,
      entryPrice: price,
      amount,
      capitalUsed: capitalPerTrade,
      entryRSI: rsi,
      entryVolumeRatio: volumeRatio,
      entryTime: new Date().toISOString(),
      status: 'open',
      stopMovedToBreakeven: false,
    };

    botMemory.trades.push(trade);
    saveMemory();

    await sendTelegram(
      `✅ *ACQUISTO ESEGUITO*\n` +
      `Coppia: ${pair}\n` +
      `Prezzo: €${price.toFixed(4)}\n` +
      `Quantità: ${amount.toFixed(6)}\n` +
      `Capitale usato: €${capitalPerTrade.toFixed(2)}\n` +
      `RSI: ${rsi.toFixed(2)}\n` +
      `TP: +${botMemory.adaptedParams.takeProfitPercent}% | SL: -${botMemory.adaptedParams.stopLossPercent}%`
    );

  } catch (err) {
    console.error('[BUY ERROR]', err.message);
    await sendTelegram(`❌ *ERRORE ACQUISTO* ${pair}\n${err.message}`);
  }
}

// ================================================
// ESEGUI VENDITA
// ================================================
async function executeSell(trade, currentPrice, reason, profitPercent) {
  try {
    console.log(`[SELL] ${trade.pair} | Motivo: ${reason} | Profit: ${profitPercent.toFixed(2)}%`);

    // Ordine reale su Kraken (commenta per test)
    // const order = await exchange.createMarketSellOrder(trade.pair, trade.amount);

    // Aggiorna trade nella memoria
    trade.status = 'closed';
    trade.exitPrice = currentPrice;
    trade.exitTime = new Date().toISOString();
    trade.profitPercent = profitPercent;
    trade.exitReason = reason;
    trade.profitEur = (trade.capitalUsed * profitPercent) / 100;

    // Aggiorna contatore perdite giornaliere
    if (profitPercent < 0) {
      const today = new Date().toDateString();
      if (botMemory.lastLossDate !== today) {
        botMemory.dailyLosses = 0;
        botMemory.lastLossDate = today;
      }
      botMemory.dailyLosses++;
    }

    saveMemory();

    // Analizza errori e adatta strategia
    analyzeErrors();

    const emoji = profitPercent > 0 ? '💚' : '🔴';
    const reasonEmoji = reason === 'TAKE_PROFIT' ? '🎯' : '🛑';

    await sendTelegram(
      `${emoji} *VENDITA - ${reasonEmoji} ${reason}*\n` +
      `Coppia: ${trade.pair}\n` +
      `Prezzo entrata: €${trade.entryPrice.toFixed(4)}\n` +
      `Prezzo uscita: €${currentPrice.toFixed(4)}\n` +
      `Profit: ${profitPercent.toFixed(2)}%\n` +
      `P&L: €${trade.profitEur.toFixed(2)}`
    );

  } catch (err) {
    console.error('[SELL ERROR]', err.message);
    await sendTelegram(`❌ *ERRORE VENDITA* ${trade.pair}\n${err.message}`);
  }
}

// ================================================
// REPORT GIORNALIERO
// ================================================
async function dailyReport() {
  const closedTrades = botMemory.trades.filter(t => t.status === 'closed');
  const totalProfitEur = closedTrades.reduce((sum, t) => sum + (t.profitEur || 0), 0);
  const wins = closedTrades.filter(t => t.profitPercent > 0).length;
  const losses = closedTrades.filter(t => t.profitPercent <= 0).length;

  await sendTelegram(
    `📊 *REPORT GIORNALIERO*\n` +
    `Trade totali: ${closedTrades.length}\n` +
    `Vincite: ${wins} | Perdite: ${losses}\n` +
    `P&L totale: €${totalProfitEur.toFixed(2)}\n` +
    `RSI soglia attuale: ${botMemory.adaptedParams.rsiThreshold}\n` +
    `Volume multiplier: ${botMemory.adaptedParams.volumeMultiplier.toFixed(1)}x`
  );
}

// ================================================
// LOOP PRINCIPALE
// ================================================
async function main() {
  console.log('🚀 Kraken Trading Bot avviato!');
  loadMemory();

  await sendTelegram(
    `🚀 *BOT AVVIATO*\n` +
    `Coppie monitorate: ${CONFIG.trading.pairs.join(', ')}\n` +
    `Capitale: €${CONFIG.trading.capitalTotal}\n` +
    `TP: +${CONFIG.trading.takeProfitPercent}% | SL: -${CONFIG.trading.stopLossPercent}%\n` +
    `Controllo ogni 4 ore`
  );

  // Report giornaliero ogni 24 ore
  setInterval(dailyReport, 24 * 60 * 60 * 1000);

  // Loop principale ogni 4 ore
  const run = async () => {
    try {
      await agentEntry();
      await agentPositionManager();
      await agentReserve();
    } catch (err) {
      console.error('[MAIN ERROR]', err.message);
      await sendTelegram(`⚠️ *ERRORE SISTEMA*\n${err.message}`);
    }
  };

  await run();
  setInterval(run, CONFIG.trading.checkIntervalMs);
}

main().catch(console.error);

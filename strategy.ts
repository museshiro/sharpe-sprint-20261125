// Dip-bounce paper bot for agent-fun/replay/v2 (pump.fun bonding curves).
//
// Idea, in one line: most new pump.fun coins bleed after launch, so this bot never
// chases a launch. It waits for a coin that already proved it can run (price peaked
// at least +50% over its create price), then dumped hard (now at most 70% of that
// peak), and is bouncing again (+3% over the last 20 slots with real buyers behind
// it). It buys that bounce once, small and early, and exits fast: +30% take-profit,
// -5% stop-loss, a trailing stop once up +30%, or 400 slots, whichever comes first.
// One trade per coin, no adds, no re-entry: the second dip keeps dipping.
//
// Two findings from offline sweeps over the dev window (128,058 events, 1,222
// mints) shaped this: first, every launch-chasing and trend-following variant
// lost money (win rates 10-27% against a ~3% round-trip fee drag), while this
// dip filter was the only family with a positive expectancy; second, a creator
// sale before entry is NOT a filter — allowing dev-sold coins adds ~30% more
// trades and raises PnL, because the dip filter itself does the quality
// selection (the bot still exits at once on a fresh creator sale while held).
// A third filter guards the launch itself: the creator's own buys in the create
// slot must stay under 2.5 SOL — bigger creator buys at launch are a bundled
// supply / rug tell, and the coins behind them lose money even after a clean dip.
// Position size is capped by the harness (1% of real SOL reserve per reply), so
// the stake is set large (0.7 SOL) and the cap does the sizing; the fixed tx fee
// then costs almost nothing per round trip.
//
// A pure function of the batches it is fed: no clock, no environment, no
// Math.random, no I/O. Diagnostics go to stderr only, never stdout.

import { BPS, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Lamports to aim for per coin (each reply is still capped at 1% of real SOL). */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for (also the guardrail round-trip floor). */
  minBuyLamports: number;
  /** Creator's own buys in the create slot: lamports window. Big creator buys
   * at launch (bundled supply) are a rug tell: entries above maxDevBuy are skipped.
   * (This filter was in the offline sweeps from the start; omitting it from the
   * first shipped revision cost ~0.95 SOL on grade-local, so it is restored here.) */
  minDevBuy: number;
  maxDevBuy: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: number;
  maxRealSol: number;
  /** Trades seen and distinct (non-creator) buyers seen before entry. */
  minTrades: number;
  minBuyers: number;
  /** Peak price vs create price (bps, 10000 = 1x) a coin must have reached. */
  minPeakBps: number;
  /** Current price as a share of the peak (bps, 10000 = at the peak), at most. */
  dipMaxBps: number;
  /** The bounce window (slots) and what it must show (bps over the window, 10000 = flat). */
  bounceWindow: number;
  bounceBps: number;
  /** Oldest age (slots since create) at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /**
   * Creator sold before entry: skip the coin for good. Off: a creator sale before
   * entry does not filter the coin (the dip filter does the selection); a fresh
   * creator sale while held still exits at once, via exitOnDevSell.
   */
  skipDevSold: boolean;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
}

export const DEFAULT_PARAMS: Params = {
  stakeLamports: 700_000_000,
  minBuyLamports: 10_000_000,
  minDevBuy: 0,
  maxDevBuy: 2_500_000_000,
  minRealSol: 1_000_000_000,
  maxRealSol: 100_000_000_000,
  minTrades: 10,
  minBuyers: 5,
  minPeakBps: 15000,
  dipMaxBps: 7000,
  bounceWindow: 20,
  bounceBps: 10300,
  maxAge: 100000,
  maxSellRatioBps: 10000,
  skipDevSold: false,
  tpBps: 3000,
  slBps: 500,
  trailArmBps: 3000,
  trailBps: 1500,
  maxHold: 400,
  exitOnDevSell: true,
};

const FEE_BPS = 125n; // protocol 95 bps + creator 30 bps fallback

/** Price snapshot (post-trade reserves) used to measure the bounce. */
interface Snapshot {
  slot: number;
  vq: bigint;
  vt: bigint;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time reserves: peak and dip are measured against this price. */
  vq0: bigint;
  vt0: bigint;
  /** Best price ratio vs create seen so far, in bps (10000 = create price). */
  peakRatio: bigint;
  /** Creator's own buys in the create slot (lamports). */
  devBuy: bigint;
  devSold: boolean;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  lastTradeSlot: number;
  /** Post-trade reserve snapshots, in slot order (create first). */
  hist: Snapshot[];
  buysSent: number;
  spentSent: bigint;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  devSoldAtOpen: boolean;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

/** Latest snapshot at or before slot - agoSlots (null when the coin is too young). */
function priceAgo(c: Coin, slot: number, agoSlots: number): Snapshot | null {
  const target = slot - agoSlots;
  const h = c.hist;
  let lo = 0;
  let hi = h.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (h[mid]!.slot <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans === -1 ? null : h[ans]!;
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  const stake = BigInt(P.stakeLamports);
  const minBuy = BigInt(P.minBuyLamports);
  let batchesSeen = 0;

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  /** Fold this batch's events into the per-coin tape. */
  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          peakRatio: BPS,
          devBuy: 0n,
          devSold: false,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          lastTradeSlot: e.slot,
          hist: [{ slot: e.slot, vq: BigInt(e.virtual_quote_reserves), vt: BigInt(e.virtual_token_reserves) }],
          buysSent: 0,
          spentSent: 0n,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const vq = BigInt(e.virtual_quote_reserves);
        const vt = BigInt(e.virtual_token_reserves);
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.hist.push({ slot: e.slot, vq, vt });
        const ratio = (vq * c.vt0 * BPS) / (vt * c.vq0);
        if (ratio > c.peakRatio) c.peakRatio = ratio;
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  return {
    onBatch(state, batch) {
      batchesSeen += 1;
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();

      // Fills: track opens, closes and tx fees paid per position.
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          // A harness close (complete / flatten / write-off): the position is gone.
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        if (f.side === 'buy' && f.status === 'filled' && !held.has(f.mint)) {
          const c = coins.get(f.mint);
          held.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            best: 0n,
            devSoldAtOpen: c?.devSold ?? false,
          });
        } else if (f.status !== 'rejected') {
          const h = held.get(f.mint);
          if (h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
      }

      // Exits first: take profit, stop loss, trailing stop, max hold, dev sell.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, devSoldAtOpen: c?.devSold ?? false };
          held.set(mint, h);
        }
        const curve = state.curves.get(mint);
        if (curve === undefined) continue;
        const value = sellValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(P.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(P.slBps))) exit = true;
          if (h.best * BPS >= basis * (BPS + BigInt(P.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(P.trailBps))) {
            exit = true;
          }
        }
        if (state.slot - h.openedSlot >= P.maxHold) exit = true;
        if (c !== undefined && P.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries: one buy per coin, only on the dip-bounce signal.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        if (age > P.maxAge) {
          c.done = true;
          continue;
        }
        if (c.buysSent > 0) continue; // no adds: one trade per coin
        if (open >= state.hello.caps.max_open_positions) continue;
        if (c.devSold && P.skipDevSold) {
          c.done = true;
          continue;
        }
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(P.minRealSol) || rq > BigInt(P.maxRealSol)) continue;
        if (c.trades < P.minTrades || c.buyers.size < P.minBuyers) continue;
        if (c.devBuy < BigInt(P.minDevBuy) || c.devBuy > BigInt(P.maxDevBuy)) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(P.maxSellRatioBps)) continue;
        // Dip-bounce signal, all measured against the create price.
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        const curRatio = (vq * c.vt0 * BPS) / (vt * c.vq0);
        if (c.peakRatio < BigInt(P.minPeakBps)) continue; // never proved it can run
        if ((curRatio * BPS) / c.peakRatio > BigInt(P.dipMaxBps)) continue; // not dumped enough
        const ago = priceAgo(c, state.slot, P.bounceWindow);
        if (ago === null) continue;
        const bounce = (vq * ago.vt * BPS) / (vt * ago.vq);
        if (bounce < BigInt(P.bounceBps)) continue; // not bouncing yet
        const room = stake - c.spentSent;
        if (room < minBuy) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = room < maxBuy ? room : maxBuy;
        if (amount < minBuy) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: 10_000 });
        free -= amount + tx;
        c.buysSent += 1;
        c.spentSent += amount;
        open += 1;
      }

      // Prune finished coins now and then so the per-batch scan stays small.
      if (batchesSeen % 500 === 0) {
        for (const [mint, c] of coins) {
          if (c.done && !held.has(mint) && state.slot - c.createSlot > P.maxAge + 5000) coins.delete(mint);
          else if (c.hist.length > 400) c.hist.splice(0, c.hist.length - 400);
        }
      }
      return orders;
    },
  };
}

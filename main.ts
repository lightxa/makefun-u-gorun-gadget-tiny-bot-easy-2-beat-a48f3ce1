// Dip-and-bounce bot for agent-fun/bars-replay/v1 (hourly Solana bars).
//
// Idea, from studying the dev window and the house baselines: the dev window
// is a choppy downtrend (every symbol ends 3-14% down, buy-and-hold loses
// about $869 of $10,000). The trend-following baselines all lose too, because
// hourly momentum in this market whipsaws: EMA cross loses $173, momentum
// $268. What wins on this data is the opposite leg: sharp 6-hour sell-offs
// in these high-volatility meme assets mean-revert within a day, so buying
// a fresh dip and exiting on a small fixed take-profit or a tight stop beats
// both holding and chasing. The same rule is regime-robust by construction:
// in a rising final window the dip entries simply fire on pullbacks, and in
// a falling one the bot spends most bars in cash, so its worst case is close
// to hold-cash (0 PnL) rather than buy-and-hold's full drawdown.
//
// Rules (per symbol, decided on a bar's close, filled at the next open):
//   Entry: not held, at least 7 closes of history, and the close is more
//     than 2.8% below the close 6 bars earlier. Buy one slice: one sixth of
//     equity (below the 25% weight cap), sized off the cash not yet spent
//     this reply. The 2.8% threshold is the compromise the impact-aware
//     offline replay picked: deeper dips have the better per-trade edge, but
//     a 3% threshold fires only ~6 trades in the calmest 72-bar stretch of
//     the dev window, under the 8-trade minimum, while 2.8% still fires
//     enough; 2.7% graded far worse on the same window, so the threshold
//     sits on a sharp local peak and the final window may treat it worse.
//   Exit, the whole position, when any one holds at a close:
//     - its value is at least 3% over its cost (take profit), or
//     - its value is at least 3% under its cost (stop loss), or
//     - 24 bars have passed since the entry bar (time exit: a dip that has
//       not bounced in a day is a trend, not a bounce; get out and recycle
//       the cash into the next dip).
//   The symmetric 3% / 3% exits beat the 3% / 2% pair in the replay: the
//   tighter stop was mostly noise, stopped out of bounces that then paid.
//   No shorts, no leverage, no averaging down: one entry per dip, and a
//   symbol just sold can only be re-entered on a fresh 6-hour dip.
// Risk control: at most 25% of equity in any one symbol, positions are
// sized off current equity, and every exit is evaluated on the real filled
// cost from the harness account, not on a hoped-for price.
//
// Everything is deterministic float64 arithmetic on the raw closes (scaled
// by each symbol's price_scale); no clock, no environment, no randomness,
// no network. Sells are sent before buys, at most max_orders_per_bar in
// all, each order capped at 100 bps slippage past the deciding close.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, BuyInput, SellInput } from './vendor/makefun-bars.ts';

const MAX_SLIPPAGE_BPS = 100;
const BPS = 10_000n;
// Entry: 6-hour dip deeper than this (as a fraction, 0.025 = 2.5%).
const DIP_FRACTION = 0.028;
const DIP_BARS = 6;
// Exit: take profit / stop loss on value vs filled cost.
const TAKE_PROFIT_NUM = 103;
const TAKE_PROFIT_DEN = 100;
const STOP_LOSS_NUM = 97;
const STOP_LOSS_DEN = 100;
// Slice of equity per entry: one sixth, under the harness weight cap.
const SLICE_DIVISOR = 6n;
// Exit: give a bounce at most this many bars to arrive.
const MAX_HOLD_BARS = 24;

// Close history per symbol, oldest first, capped to the bars we need.
const closes = new Map<string, number[]>();
// The batch seq on which each held position was entered.
const enteredAt = new Map<string, number>();

function closePrice(state: BarsState, symbol: string): number | null {
  const meta = state.symbols.get(symbol);
  const bar = state.latest.get(symbol);
  if (meta === undefined || bar === undefined) return null;
  return Number(BigInt(bar.c)) / 10 ** meta.price_scale;
}

function sixHourDip(symbol: string): boolean {
  const hist = closes.get(symbol);
  if (hist === undefined || hist.length <= DIP_BARS) return false;
  const now = hist[hist.length - 1]!;
  const then = hist[hist.length - 1 - DIP_BARS]!;
  if (then <= 0 || now <= 0) return false;
  return (now - then) / then < -DIP_FRACTION;
}

function shouldExit(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }): boolean {
  const value = state.value(symbol, held.qty);
  if (value * BigInt(TAKE_PROFIT_DEN) >= held.cost * BigInt(TAKE_PROFIT_NUM)) return true;
  if (value * BigInt(STOP_LOSS_DEN) <= held.cost * BigInt(STOP_LOSS_NUM)) return true;
  const entered = enteredAt.get(symbol);
  if (entered !== undefined && state.seq - entered >= MAX_HOLD_BARS) return true;
  return false;
}

await runBars({
  onBatch(state, batch) {
    // Fold this batch's closes into history before deciding.
    for (const bar of batch.bars) {
      const price = closePrice(state, bar.symbol);
      if (price === null) continue;
      let hist = closes.get(bar.symbol);
      if (hist === undefined) {
        hist = [];
        closes.set(bar.symbol, hist);
      }
      hist.push(price);
      if (hist.length > DIP_BARS + 1) hist.shift();
    }
    // Drop entry markers for positions the harness no longer holds
    // (flattened or sold): they are not ours to time-exit any more.
    for (const symbol of [...enteredAt.keys()]) {
      if (!state.positions.has(symbol)) enteredAt.delete(symbol);
    }

    const { caps, fees } = state.hello;
    const fresh = new Set(batch.bars.map((b) => b.symbol));
    const sells: SellInput[] = [];
    const entries: string[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        if (shouldExit(state, symbol, held)) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
        continue;
      }
      if (sixHourDip(symbol)) entries.push(symbol);
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const stake = state.equity / SLICE_DIVISOR;
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    // Sells free cash only at the next open, so buys are sized off the cash
    // on hand now; count positions sold this reply as still occupying a slot
    // until their proceeds land.
    const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
    let room = slots - state.positions.size;
    let cash = state.cash;
    for (const symbol of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      let slice = stake < byWeight ? stake : byWeight;
      if (cash < slice) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      enteredAt.set(symbol, state.seq);
      cash -= slice;
      room--;
    }
    return orders;
  },
});

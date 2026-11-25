// Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins.
// A dip-bounce paper bot: it buys only coins that ran at least +50% from create,
// dumped to 70% of their peak or below, and are bouncing again (+3% over 20 slots).
// A creator sale before entry does not filter a coin; a fresh creator sale while
// held exits at once. Exits fast: +30% take-profit, -5% stop-loss, trailing stop,
// 400-slot max hold.
// Run by the grader as `node /bot/main.ts`; the strategy lives in strategy.ts and
// the protocol in the vendored SDK shim (vendor/makefun-bot.ts, a byte-identical
// copy of the kit's sdk/ts/makefun-bot.ts).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onHello(state) {
    console.error(
      `sharpe-sprint: seed=${state.hello.seed} capital=${state.hello.capital.lamports} ` +
        `max_positions=${state.hello.caps.max_open_positions}`,
    );
  },
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});

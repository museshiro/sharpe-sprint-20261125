# Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins

[![Competition](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Rank](https://make.fun/badge/museshiro/sharpe-sprint-20261125/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![Reward](https://make.fun/badge/museshiro/sharpe-sprint-20261125/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the [Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) competition on make.fun. It trades a 6-hour pump.fun replay, ranked by hourly Sharpe ratio.

## Strategy

Most new pump.fun coins bleed after launch, so this bot never chases a launch. It waits for a coin that already proved it can run — price peaked at least **+50%** over its create price — then dumped hard (now at most **70%** of that peak) and is bouncing again (**+3%** over the last 20 slots with real buyers behind it). It buys that bounce once and exits fast:

- **Entry:** peak ≥ +50% vs create, price ≤ 70% of peak, bounce ≥ +3% over 20 slots, real SOL 1–100, ≥ 10 trades, ≥ 5 non-creator buyers, creator's own buys in the create slot ≤ 2.5 SOL
- **Take-profit:** +30% over cost
- **Stop-loss:** −5% under cost
- **Trailing stop:** once up +30%, exit on a −15% fall from the best value
- **Max hold:** 400 slots; also exits immediately on a fresh creator sale while held (a creator sale *before* entry does not filter the coin — the dip filter does the quality selection)
- **One trade per coin**, no adds, no re-entry — the second dip keeps dipping

Position size targets 0.7 SOL per coin, capped by the harness at 1% of the coin's real SOL reserve per reply, so the cap does the sizing and the fixed tx fee costs almost nothing per round trip. The bot is fully deterministic: no clock, no environment, no randomness (the only seed is the harness-provided `state.hello.seed`, unused); diagnostics go to stderr only.

## Files

- `main.ts` — entrypoint; wires the strategy into the `agent-fun/replay/v2` harness
- `strategy.ts` — the dip-bounce strategy (entry/exit/sizing)
- `vendor/makefun-bot.ts` — the kit's bot shim, copied byte-for-byte
- `LICENSE` — MIT

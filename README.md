# saturn2022-crank

The keeper server for [saturn2022](https://saturn2022.com) vaults. Reads
the state of every covered-call vault on Robinhood Chain, writes fresh options
at the strike and expiry the board expects, settles what has expired, and folds
premiums back into the per-share running total.

The crank decides nothing about price. Premiums are computed on chain when a
buyer pays, from Chainlink and Black-Scholes, so a wrong number here buys
nobody anything. The keeper only sends transactions; every path moves assets
between the vault and the house.

## What it does, one pass at a time

For each vault in `VAULTS`, on every tick:

1. Read `free()`: shares sitting in the vault that are not escrowed against an
   open option.
2. For each free share, `write(strike, expiry)` a covered call, at
   `STRIKE_BPS/10000` of the feed's spot, expiring on the next Friday close at
   least `TENOR_DAYS - 2` days away. This lands on the board's grid: rounded
   dollar strikes and Friday close expiries. With `TENOR_MINUTES` set the
   crank writes the short end instead: expiry that many minutes out, strike
   to the cent, and only while the feed is publishing rounds. The feed goes
   silent outside the underlying's market session, and an option written into
   that silence would have no round near its expiry to settle against, so
   feed freshness is the market calendar, read from the source.
3. For each open option past expiry, pin the settlement round (the last
   Chainlink round at or before expiry) and call `settle()`. The share
   partitions itself: `max(price - strike, 0) / price` to the buyer, the rest
   back to the vault.
4. Call `collect()` to fold any premiums that arrived into the per-share
   accumulator so depositors can `claim()` them.

## What the key can do

The keeper key can `write` and `settle` on vaults in `VAULTS`. Nothing else.
Both verbs move assets only between the vault and the house, never out to
anyone. A stolen key can write badly-struck options, tying up the vault's
shares until they expire; it cannot take a share.

## Configuration

```
HOOD_RPC        node endpoint       (default: the public one)
CRANK_KEY       0x-prefixed private key of the keeper
VAULTS          comma-separated vault addresses
STRIKE_BPS      strike as basis points of spot   (default 11000, +10%)
TENOR_DAYS      days to expiry, rounded to next Friday close (default 7)
TENOR_MINUTES   minutes to expiry, overrides TENOR_DAYS when set
FRESH_SEC       max feed-round age before writes pause (default 7200)
INTERVAL_SEC    seconds between passes           (default 3600)
DRY_RUN         "1" to decide and print, never send
```

## Running

```
npm install
DRY_RUN=1 npm run once      # one pass, prints intent, nothing sent
npm start                   # the loop, sending
```

## Deployment

Two options, either works.

### Railway

`railway.json` is included. Push the repo to a Railway service, set the
environment variables above in the dashboard, and it runs on their always-on
container with automatic restarts.

### macOS launchd

Create a plist under `~/Library/LaunchAgents/`:

```xml
<plist version="1.0">
<dict>
  <key>Label</key><string>fun.saturn2022.crank</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>/path/to/run.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

Where `run.sh` exports the env vars and execs `node crank.mjs`.

## Auditing a run

`DRY_RUN=1` prints exactly what the loop would send without sending anything.
Every write and settle logs the vault, strike, expiry and, on send, the tx
hash, so an operator can trace any state change back to a signed intent.

// The vault's hands.
//
// Everything a covered-call vault does on its own schedule and nothing else:
// settle options whose expiry has passed, then write fresh ones against
// whatever stock is sitting free. It decides nothing about price. Premiums are
// computed on chain at the moment of purchase, so this process could publish a
// wrong number and no buyer would pay it.
//
// It holds one key and that key can do two things: write and settle. Both move
// assets only between the vault and the house, never out to anyone. A stolen
// crank key can write badly-struck options; it cannot take a share.
//
//   HOOD_RPC        node endpoint            (default: the public one)
//   CRANK_KEY       0x-prefixed private key  (required to send)
//   VAULTS          comma-separated vault addresses
//   STRIKE_BPS      strike as basis points of spot   (default 11000, +10%)
//   TENOR_DAYS      days to expiry                   (default 7: the longest tenor the backtest measured, scripts/11-backtest.mjs)
//   TENOR_MINUTES   minutes to expiry, overrides TENOR_DAYS when set
//   INTERVAL_SEC    seconds between passes           (default 3600)
//   DRY_RUN         "1" to decide but never send
//
// TENOR_MINUTES exists for the short end, where the weekly board does not
// reach. An option's whole time value lives inside roughly one standard
// deviation of spot, and over an hour that is about 0.7%, so the dollar grid
// the board is built on steps clean over it: the nearest listed strike to a
// $143 spot is $145, which prices at a third of the vault's premium floor and
// is refused. A short tenor therefore writes off the board's grid, at a strike
// a little under spot, and shows up in the contracts table rather than in the
// chain. Under spot rather than at it because the strike is fixed here and
// the premium is computed on chain when the transaction lands: at the money a
// 1% dip in that gap prices the write under the floor and reverts it, while
// half a percent in the money carries six times the floor and survives.

import {
  createPublicClient, createWalletClient, http, parseAbi, defineChain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.HOOD_RPC ?? "https://rpc.mainnet.chain.robinhood.com";
const STRIKE_BPS = BigInt(process.env.STRIKE_BPS ?? 11000);
const TENOR_DAYS = BigInt(process.env.TENOR_DAYS ?? 7);
const TENOR_MINUTES = process.env.TENOR_MINUTES ? Number(process.env.TENOR_MINUTES) : null;
const FRESH_SEC = Number(process.env.FRESH_SEC ?? 7200);
const INTERVAL = Number(process.env.INTERVAL_SEC ?? 3600) * 1000;
const DRY = process.env.DRY_RUN === "1";

const hood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const vaultAbi = parseAbi([
  "function stock() view returns (address)",
  "function house() view returns (address)",
  "function marketId() view returns (uint32)",
  "function keeper() view returns (address)",
  "function free() view returns (uint256)",
  "function openCount() view returns (uint256)",
  "function openSeries(uint256) view returns (uint256)",
  "function write(uint96 strike, uint40 expiry) returns (uint256)",
  "function settle(uint256 index, uint80 roundId)",
  "function collect()",
]);
const houseAbi = parseAbi([
  "function series(uint256) view returns (uint32 market, address writer, address buyer, uint96 strike, uint40 expiry, bool settled)",
  "function markets(uint256) view returns (address stock, address feed, int64 deviation)",
]);
const feedAbi = parseAbi([
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "function getRoundData(uint80) view returns (uint80, int256, uint256, uint256, uint80)",
]);

const log = (...a) => console.log(new Date().toISOString(), ...a);

const pub = createPublicClient({ chain: hood, transport: http(RPC) });
const account = process.env.CRANK_KEY ? privateKeyToAccount(process.env.CRANK_KEY) : null;
const wallet = account ? createWalletClient({ account, chain: hood, transport: http(RPC) }) : null;

/// The last round at or before `t`. Settlement is pinned to it, so this walks
/// back rather than taking the latest: the latest can be days after expiry.
async function roundAtOrBefore(feed, t) {
  const [latest] = await pub.readContract({ address: feed, abi: feedAbi, functionName: "latestRoundData" });
  for (let i = latest; i > latest - 500n; i--) {
    const [, , , ts] = await pub.readContract({
      address: feed, abi: feedAbi, functionName: "getRoundData", args: [i],
    });
    if (ts !== 0n && ts <= t) return i;
  }
  return null;
}

async function send(fn) {
  if (DRY || !wallet) { log("   (dry run, not sent)"); return null; }
  const hash = await wallet.writeContract(fn);
  const r = await pub.waitForTransactionReceipt({ hash });
  log("   tx", hash, r.status);
  return r;
}

async function pass(vault) {
  const [stock, house, marketId, keeper, free, openCount] = await Promise.all([
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "stock" }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "house" }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "marketId" }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "keeper" }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "free" }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: "openCount" }),
  ]);
  log(`vault ${vault}  free ${Number(free) / 1e18} shares, ${openCount} open`);

  if (account && keeper.toLowerCase() !== account.address.toLowerCase()) {
    log(`   not the keeper (${keeper}); writing would revert. Settles still work.`);
  }
  const [, feed] = await pub.readContract({ address: house, abi: houseAbi, functionName: "markets", args: [BigInt(marketId)] });
  const now = BigInt((await pub.getBlock()).timestamp);

  // 1. settle anything past expiry, newest index first so the swap-and-pop
  //    inside the vault cannot shuffle an index out from under this loop.
  for (let i = Number(openCount) - 1; i >= 0; i--) {
    const id = await pub.readContract({ address: vault, abi: vaultAbi, functionName: "openSeries", args: [BigInt(i)] });
    const s = await pub.readContract({ address: house, abi: houseAbi, functionName: "series", args: [id] });
    const expiry = BigInt(s[4]);
    if (expiry > now) continue;
    const round = await roundAtOrBefore(feed, expiry);
    if (round === null) { log(`   series ${id}: no round covers expiry yet, leaving it`); continue; }
    log(`   settling series ${id} at round ${round}`);
    await send({ address: vault, abi: vaultAbi, functionName: "settle", args: [BigInt(i), round] });
  }

  // 2. write against whatever is free, one whole share at a time
  const freeNow = await pub.readContract({ address: vault, abi: vaultAbi, functionName: "free" });
  const whole = freeNow / 10n ** 18n;
  if (whole === 0n) { log("   nothing free to write against"); return; }

  const [, spot, , updatedAt] = await pub.readContract({ address: feed, abi: feedAbi, functionName: "latestRoundData" });

  // The feed follows the underlying's market session: rounds arrive every few
  // minutes while it trades and stop entirely overnight and on holidays. A
  // silent feed means an option written now would have no round near its
  // expiry to settle against, so writing waits for the session instead of a
  // calendar: freshness is the market being open, measured at the source.
  const age = Number(now - BigInt(updatedAt));
  if (age > FRESH_SEC) {
    log(`   feed silent for ${(age / 3600).toFixed(1)}h (market closed), not writing`);
    return;
  }

  // The board lists fixed instruments: round dollar strikes and Friday-close
  // expiries. Writing off-grid would put contracts nobody's screen points at,
  // so the strike is rounded to the exchange-style step for this price and the
  // expiry is the next Friday 20:00 UTC at least TENOR_DAYS - 2 days out.
  const raw = (spot * STRIKE_BPS) / 10000n;
  const short = TENOR_MINUTES !== null;
  const strike = short ? centStrike(raw) : gridStrike(raw);
  const expiry = short
    ? Number(now) + TENOR_MINUTES * 60
    : nextFridayClose(Number(now) + (Number(TENOR_DAYS) - 2) * 86400);
  const when = short
    ? `${TENOR_MINUTES}min (${new Date(expiry * 1000).toISOString().slice(11, 19)}Z)`
    : new Date(expiry * 1000).toISOString().slice(0, 10);
  log(`   writing ${whole} call(s), strike ${Number(strike) / 1e8}, expiry ${when}`);
  for (let n = 0n; n < whole; n++) {
    await send({ address: vault, abi: vaultAbi, functionName: "write", args: [strike, Number(expiry)] });
  }

  // 3. fold any premiums that arrived into the per-share running total
  await send({ address: vault, abi: vaultAbi, functionName: "collect" });
}

/** Exchange-style strike spacing, in the feed's 1e8 units. */
function gridStrike(raw1e8) {
  const dollars = Number(raw1e8) / 1e8;
  const step = dollars < 50 ? 1 : dollars < 100 ? 2.5 : dollars < 250 ? 5 : dollars < 500 ? 10 : dollars < 1000 ? 25 : 50;
  return BigInt(Math.round((Math.round(dollars / step) * step) * 1e8));
}

/** Strike to the cent, for tenors too short for the dollar grid to price. */
function centStrike(raw1e8) {
  return (raw1e8 / 1_000_000n) * 1_000_000n;
}

/** The first Friday 20:00 UTC at or after `after` (unix seconds). */
function nextFridayClose(after) {
  const d = new Date(after * 1000);
  d.setUTCHours(20, 0, 0, 0);
  while (d.getUTCDay() !== 5 || d.getTime() / 1000 < after) {
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return Math.floor(d.getTime() / 1000);
}

async function main() {
  const vaults = (process.env.VAULTS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  if (!vaults.length) { console.error("set VAULTS to one or more vault addresses"); process.exit(1); }
  log(`crank up. ${vaults.length} vault(s), every ${INTERVAL / 1000}s${DRY ? ", dry run" : ""}`);
  if (account) log(`signing as ${account.address}`);
  else log("no CRANK_KEY: reading only");

  const once = process.argv.includes("--once");
  for (;;) {
    for (const v of vaults) {
      try { await pass(v); }
      catch (e) { log(`   vault ${v} failed this pass: ${e.shortMessage ?? e.message}`); }
    }
    if (once) return;
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

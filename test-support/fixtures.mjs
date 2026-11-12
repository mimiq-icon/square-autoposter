// test-support/fixtures.mjs: sample API responses shared by the unit tests and the end-to-end mock, shaped like the real services (not a test file itself).
export const STABLECOINS = {
  peggedAssets: [
    { id: "1", name: "Tether", symbol: "USDT", pegType: "peggedUSD", pegMechanism: "fiat-backed", price: 1, circulating: { peggedUSD: 187_200_000_000 }, circulatingPrevWeek: { peggedUSD: 186_000_000_000 } },
    { id: "2", name: "USD Coin", symbol: "USDC", pegType: "peggedUSD", pegMechanism: "fiat-backed", price: 0.9998, circulating: { peggedUSD: 72_900_000_000 }, circulatingPrevWeek: { peggedUSD: 72_100_000_000 } },
    { id: "3", name: "Dai", symbol: "DAI", pegType: "peggedUSD", pegMechanism: "crypto-backed", circulating: { peggedUSD: 5_300_000_000 }, circulatingPrevWeek: { peggedUSD: 5_400_000_000 } },
    { id: "4", name: "Ethena USDe", symbol: "USDe", pegType: "peggedUSD", circulating: { peggedUSD: 6_400_000_000 } },
    { id: "5", name: "Euro Coin", symbol: "EURC", pegType: "peggedEUR", circulating: { peggedEUR: 1_000_000_000 } },
    { id: "6", name: "Broken", symbol: "BRK", pegType: "peggedUSD", circulating: null },
  ],
};
export const CHAINS = [
  { name: "Ethereum", tvl: 72_000_000_000, tokenSymbol: "ETH" },
  { name: "Solana", tvl: 11_000_000_000, tokenSymbol: "SOL" },
  { name: "BSC", tvl: 6_500_000_000, tokenSymbol: "BNB" },
  { name: "Tron", tvl: 5_200_000_000, tokenSymbol: "TRX" },
  { name: "Base", tvl: 4_100_000_000 },
  { name: "Arbitrum", tvl: 2_900_000_000 },
  { name: "Not a number", tvl: "x" },
];
export const FEES = {
  total24h: 95_000_000,
  protocols: [
    { name: "tether", displayName: "Tether", total24h: 30_000_000 },
    { displayName: "Circle", total24h: 12_000_000 },
    { name: "Uniswap", total24h: 9_000_000 },
    { name: "Lido", total24h: 6_000_000 },
    { name: "Aave", total24h: 5_000_000 },
    { name: "Idle", total24h: 0 },
  ],
};
export const difficulty = (nowMs = Date.now()) => ({ progressPercent: 62.4, difficultyChange: -1.8, previousRetarget: 2.3, remainingBlocks: 758, remainingTime: 454_800_000, estimatedRetargetDate: nowMs + 5 * 86_400_000 });
export const TIP_HEIGHT = 940_123;
export const POOLS = {
  blockCount: 1004,
  pools: [
    { poolId: 1, name: "Foundry USA", blockCount: 303 },
    { poolId: 2, name: "AntPool", blockCount: 189 },
    { poolId: 3, name: "F2Pool", blockCount: 113 },
    { poolId: 4, name: "ViaBTC", blockCount: 104 },
    { poolId: 5, name: "Binance Pool", blockCount: 71 },
    { poolId: 6, name: "Idle Pool", blockCount: 0 },
  ],
};
export const HASHRATE = { currentHashrate: 7.2e20, difficulty: 1.08e14 };

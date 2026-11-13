export const FASTNEAR_TESTNET_RPC = "https://test.rpc.fastnear.com";
export const PUBLIC_TESTNET_RPC = "https://rpc.testnet.near.org";
export const DEFAULT_RPC_URL = FASTNEAR_TESTNET_RPC;
export const VIEW_TIMEOUT_MS = 8_000;

/** Primary testnet RPC, then the other public endpoint. An explicit URL is used alone. */
export function rpcCandidates(explicit?: string): string[] {
  const pinned = explicit?.trim();
  if (pinned) return [pinned];
  const primary = (process.env.NEAR_RPC_URL || DEFAULT_RPC_URL).trim() || DEFAULT_RPC_URL;
  const extras = [FASTNEAR_TESTNET_RPC, PUBLIC_TESTNET_RPC].filter((url) => url !== primary);
  return [primary, ...extras];
}

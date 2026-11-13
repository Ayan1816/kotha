# Kotha — Speak. Verify. Execute.

Bangla-first NEAR testnet copilot. Speak or type a swap, transfer, or vault move, preview it against the spending rules, and let an authorized wallet record a hardware-attested receipt.

#NEARHackathon @NEARProtocol

## App

The app has four tabs:

- **Chat** — voice and text. Transfer, swap, vault, blocked, and invalid-account previews are computed locally. They do not call `/api/tee-chat` and they do not use the free AI quota.
- **Spending Guard** — dry-run and Execute. Execute stays disabled until the connected wallet is the on-chain vault owner or the on-chain agent.
- **Proofs** — verified executions stored by the vault.
- **Settings** — NEAR AI key, admin mode, owner policy, and the phone book.

Live app: https://kotha-ayan19.vercel.app

Contract: `kotha-vault-1793945609.testnet`

RPC: `https://test.rpc.fastnear.com` (fallback `https://rpc.testnet.near.org`). A failed view is cached for 5 seconds.

`record_execution` accepts the vault owner or the agent. The owner wallet `mohin12.testnet` is the agent that should sign executions. Set it with the manual workflow `.github/workflows/set-agent.yml` (`workflow_dispatch`, input `agent`, default `mohin12.testnet`). That workflow calls `update_agent_account({"agent_account": ...})` with the `NEAR_CONTRACT_ID` and `NEAR_PRIVATE_KEY` secrets, then prints `get_vault_info`. Policy, freeze, and grant changes stay owner-only.

USD amounts on a receipt are attested by the recorder in `usd_amount_cents`. The chain stores that number. It does not price assets.

## Demo video

Demo video: add the recording link here.

## Checks

From `web/`:

```bash
npm test
npm run build
```

Contract tests: `cd contract && cargo test`

`ci.yml` typechecks the web app and runs the contract tests on every push. `ci-deploy.yml` deploys the contract only on `workflow_dispatch` or when files under `contract/` change. A web-only push does not redeploy the contract.

## Env

See `web/.env.example`. The contract id is `NEXT_PUBLIC_CONTRACT_ID=kotha-vault-1793945609.testnet`. Optional: `NEAR_RPC_URL`, `NEAR_AI_BASE_URL`, `NEAR_INTENTS_AGENT_ID`, `NEAR_INTENTS_OWNER_ACCOUNT`.

# USDC Sepolia Bridge

A testnet frontend built with Arc Studio for bridging test USDC from Ethereum Sepolia to Arbitrum Sepolia using Circle Bridge Kit.

## Features

- Connect an injected browser wallet.
- View test USDC balances on both networks.
- Enter an amount and destination address.
- Follow approval, burn, attestation, and mint steps with explorer links when transaction hashes are available.
- Validate amounts using integer token units.

## Run locally

Requires Node.js 22 or later and npm.

```bash
npm ci
npm run dev
```

Open the local URL printed by Vite. No private key, seed phrase, backend API key, or wallet address needs to be entered into source files. Signing takes place in the connected wallet.

```bash
npm run typecheck
npm run build
```

## Testnet workflow

Use a dedicated test wallet with test USDC and test ETH on Ethereum Sepolia. Destination minting may also require test ETH on Arbitrum Sepolia. Review the wallet prompts, network, recipient, amount, and fees before signing. Test tokens have no monetary value.

The transfer route is Ethereum Sepolia to Arbitrum Sepolia. This repository does not deploy contracts to Arc or bridge funds to Arc.

## Status and limitations

This is a learning prototype, not an audited financial product. The original interface displayed a completed transfer during testing, but this cleaned repository has not been independently verified with a new end-to-end transfer. Compilation checks do not establish successful settlement.

Progress and retry data are held in memory and are lost on refresh. Error recovery, repeated event subscriptions, and reconnect behavior need further review. Inspect existing transaction receipts and destination settlement before retrying; do not assume a timeout means a transfer failed. Destination balance display tracks the connected account, which may differ from a custom recipient.

## Public source preparation

This edition contains the browser-wallet flow. The personal Circle wallet configuration, hosted tracing, console capture, deployment tooling, credentials, environment files, and transaction logs are excluded.

## References

- [Circle Bridge Kit](https://developers.circle.com/bridge-kit)
- [Arc Studio](https://studio.arc.io/)

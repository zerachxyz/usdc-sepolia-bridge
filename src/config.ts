/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, createConfig } from 'wagmi'
import { mainnet, sepolia, arbitrumSepolia } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'


export const config = createConfig({
  chains: [sepolia, arbitrumSepolia, mainnet], // mainnet needed for ENS resolution
  connectors: [injected()],
  transports: {
    [sepolia.id]: http(),
    [arbitrumSepolia.id]: http(),
    [mainnet.id]: http(), // ENS resolution uses mainnet
  },
})

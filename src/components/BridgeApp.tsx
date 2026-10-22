/**
 * BridgeApp — USDC Bridge: Ethereum Sepolia → Arbitrum Sepolia
 * Browser wallet (injected EIP-1193 provider) — BridgeKit CCTP flow.
 *
 * Amount precision: all validation uses bigint via Amount/parseAmount — no float
 * arithmetic on values passed to the bridge or CLI.
 * Fees: never hardcoded; displayed as "check live" with CLI command or "not available".
 * Timing: never promised; displayed as "check live" when Forwarding Service is used.
 */

import { useState, useCallback, useRef } from 'react'
import { useAccount, useReadContract, useSwitchChain } from 'wagmi'
import { ConnectKitButton } from 'connectkit'
import { erc20Abi } from 'viem'
import { sepolia, arbitrumSepolia } from 'wagmi/chains'
import { BridgeKit } from '@circle-fin/bridge-kit'
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2'
import type { EIP1193Provider } from 'viem'
import {
  ExternalLink, ArrowDown, Loader2, CheckCircle2, XCircle,
  RefreshCw, AlertTriangle, Wallet, Terminal,
} from 'lucide-react'
import { NetworkEthereum, NetworkArbitrumOne, TokenUSDC } from '@web3icons/react'
import { getUsdc, buildTxExplorerUrl, requireChain } from '@/onchain-facts'
import { Amount, usdcDecimalsFor, parseAmount, AmountError } from '@/onchain-money'
import { toast } from 'sonner'

// --- Chain constants (values from registry, never typed from memory) ---
const SOURCE_CHAIN = sepolia
const DEST_CHAIN = arbitrumSepolia

const SOURCE_CHAIN_NAME = 'Ethereum_Sepolia'
const DEST_CHAIN_NAME = 'Arbitrum_Sepolia'

const SOURCE_USDC = getUsdc(SOURCE_CHAIN.id)!
const DEST_USDC = getUsdc(DEST_CHAIN.id)!

const SOURCE_FACTS = requireChain(SOURCE_CHAIN.id)
const DEST_FACTS = requireChain(DEST_CHAIN.id)

// Singleton BridgeKit (no kit key needed for bridge operations)
const bridgeKit = new BridgeKit()

// --- Types ---
type StepName = 'approve' | 'burn' | 'fetchAttestation' | 'mint'
type StepState = 'idle' | 'pending' | 'success' | 'error'

interface StepStatus {
  name: StepName
  label: string
  state: StepState
  txHash?: string
  error?: string
}

type BridgePhase = 'idle' | 'bridging' | 'success' | 'error'

const INITIAL_STEPS: StepStatus[] = [
  { name: 'approve', label: 'Approve USDC spend', state: 'idle' },
  { name: 'burn', label: 'Burn on Ethereum Sepolia', state: 'idle' },
  { name: 'fetchAttestation', label: 'Circle attestation', state: 'idle' },
  { name: 'mint', label: 'Mint on Arbitrum Sepolia', state: 'idle' },
]

function formatAddress(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

function parseOnchainError(error: unknown): string {
  const msg = (error as { message?: string })?.message?.toLowerCase() ?? ''
  if (msg.includes('user rejected') || (error as { code?: number })?.code === 4001) {
    return 'Transaction cancelled by user.'
  }
  if (msg.includes('insufficient funds') || msg.includes('exceeds balance')) {
    return 'Insufficient balance. Please add test funds and try again.'
  }
  if (msg.includes('reverted')) {
    const match = msg.match(/reason="([^"]+)"/)
    return match ? `Transaction failed: ${match[1]}` : 'Transaction reverted. Please try again.'
  }
  if (msg.includes('network') || msg.includes('timeout')) {
    return 'Network error. Please check your connection and retry.'
  }
  return (error as { message?: string })?.message?.slice(0, 160) ?? 'Something went wrong. Please try again.'
}

// --- Sub-components ---

function StepRow({ step, chainId }: { step: StepStatus; chainId: number }) {
  const explorerLink = step.txHash ? buildTxExplorerUrl(chainId, step.txHash) : undefined
  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="flex items-center gap-2.5 min-w-0">
        {step.state === 'idle' && (
          <div className="size-5 rounded-full border flex-shrink-0" style={{ borderColor: 'var(--border)' }} />
        )}
        {step.state === 'pending' && (
          <Loader2 className="size-5 animate-spin flex-shrink-0" style={{ color: 'var(--accent)' }} />
        )}
        {step.state === 'success' && (
          <CheckCircle2 className="size-5 flex-shrink-0" style={{ color: 'var(--success)' }} />
        )}
        {step.state === 'error' && (
          <XCircle className="size-5 flex-shrink-0" style={{ color: 'var(--danger)' }} />
        )}
        <div className="min-w-0">
          <span
            className="text-sm font-medium block truncate"
            style={{ color: step.state === 'idle' ? 'var(--subtle)' : 'var(--ink)' }}
          >
            {step.label}
          </span>
          {step.error && (
            <span className="text-xs block truncate" style={{ color: 'var(--danger)' }}>{step.error}</span>
          )}
        </div>
      </div>
      {explorerLink && step.state !== 'idle' && (
        <a
          href={explorerLink}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium flex-shrink-0 ml-2"
          style={{ color: 'var(--accent)' }}
        >
          View <ExternalLink className="size-3" />
        </a>
      )}
    </div>
  )
}

function ChainPill({ chainId, label, role }: { chainId: number; label: string; role: 'from' | 'to' }) {
  return (
    <div
      className="flex items-center gap-2 rounded-xl px-3 py-2"
      style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)' }}
    >
      {chainId === SOURCE_CHAIN.id
        ? <NetworkEthereum variant="branded" size={20} />
        : <NetworkArbitrumOne variant="branded" size={20} />
      }
      <div>
        <p className="text-xs font-medium" style={{ color: 'var(--muted)' }}>
          {role === 'from' ? 'From' : 'To'}
        </p>
        <p className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>{label}</p>
      </div>
    </div>
  )
}

// --- Browser Wallet Mode ---

function BrowserWalletMode() {
  const { address, isConnected, connector, chainId: walletChainId } = useAccount()
  const { switchChainAsync } = useSwitchChain()

  // Raw string amount — never float; validated via Amount/parseAmount
  const [amountInput, setAmountInput] = useState('')
  const [recipientAddress, setRecipientAddress] = useState('')
  const [phase, setPhase] = useState<BridgePhase>('idle')
  const [steps, setSteps] = useState<StepStatus[]>(INITIAL_STEPS)
  const [bridgeError, setBridgeError] = useState<string | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lastResultRef = useRef<any>(null)
  const [isRetrying, setIsRetrying] = useState(false)

  const effectiveRecipient = recipientAddress || (address ?? '')

  // --- Live balances ---
  const { data: rawSourceBalance, isLoading: srcLoading, refetch: refetchSrc } = useReadContract({
    address: SOURCE_USDC.address as `0x${string}`,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address as `0x${string}`],
    chainId: SOURCE_CHAIN.id,
    query: { enabled: !!address },
  })

  const { data: rawDestBalance, isLoading: dstLoading, refetch: refetchDst } = useReadContract({
    address: DEST_USDC.address as `0x${string}`,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address as `0x${string}`],
    chainId: DEST_CHAIN.id,
    query: { enabled: !!address },
  })

  const srcFormatted = rawSourceBalance != null
    ? Amount.fromRaw(rawSourceBalance, usdcDecimalsFor(SOURCE_CHAIN.id)).toFixed(6)
    : null
  const dstFormatted = rawDestBalance != null
    ? Amount.fromRaw(rawDestBalance, usdcDecimalsFor(DEST_CHAIN.id)).toFixed(6)
    : null

  // --- Amount validation (bigint-safe) ---
  let amountError: string | null = null
  let parsedAmountBigint: bigint | null = null
  let amountForBridge: string | null = null  // exact decimal string

  if (amountInput.trim()) {
    try {
      const parsed = parseAmount(SOURCE_CHAIN.id, amountInput.trim())
      parsedAmountBigint = parsed.raw
      amountForBridge = Amount.fromRaw(parsed.raw, usdcDecimalsFor(SOURCE_CHAIN.id)).toString()
      if (parsed.raw <= 0n) amountError = 'Amount must be greater than zero.'
      else if (rawSourceBalance != null && parsed.raw > rawSourceBalance) {
        amountError = `Exceeds balance (${srcFormatted} USDC on Sepolia)`
      }
    } catch (e) {
      if (e instanceof AmountError) {
        amountError = e.code === 'TOO_MANY_FRACTION_DIGITS'
          ? `Too many decimal places — USDC has ${usdcDecimalsFor(SOURCE_CHAIN.id)} decimals max.`
          : e.message
      } else {
        amountError = 'Invalid amount.'
      }
    }
  }

  const isAddressValid = /^0x[0-9a-fA-F]{40}$/.test(effectiveRecipient)
  const isOnWrongChain = walletChainId !== SOURCE_CHAIN.id
  const isAmountReady = !!amountInput.trim() && !amountError && parsedAmountBigint != null
  const canBridge = isConnected && isAmountReady && isAddressValid && phase !== 'bridging'

  const updateStep = useCallback((name: StepName, patch: Partial<StepStatus>) => {
    setSteps(prev => prev.map(s => s.name === name ? { ...s, ...patch } : s))
  }, [])

  const attachEvents = useCallback(() => {
    bridgeKit.on('approve', (payload) => {
      if (payload.protocol === 'cctp') {
        updateStep('approve', { state: 'success', txHash: payload.values.txHash })
      }
    })
    bridgeKit.on('burn', (payload) => {
      updateStep('approve', { state: 'success' })
      updateStep('burn', { state: 'success', txHash: payload.values.txHash })
      updateStep('fetchAttestation', { state: 'pending' })
    })
    bridgeKit.on('fetchAttestation', (payload) => {
      if (payload.protocol === 'cctp' && payload.values.state === 'success') {
        updateStep('fetchAttestation', { state: 'success' })
        updateStep('mint', { state: 'pending' })
      }
    })
    bridgeKit.on('mint', (payload) => {
      updateStep('mint', { state: 'success', txHash: payload.values.txHash })
    })
  }, [updateStep])

  const executeBridge = useCallback(async (isRetry = false) => {
    if (!connector || !isConnected || !amountForBridge) return

    if (!isRetry) {
      setSteps(INITIAL_STEPS.map(s => ({ ...s })))
      setBridgeError(null)
    }
    setPhase('bridging')
    attachEvents()
    if (!isRetry) updateStep('approve', { state: 'pending' })

    try {
      if (walletChainId !== SOURCE_CHAIN.id) {
        await switchChainAsync({ chainId: SOURCE_CHAIN.id })
      }
      const provider = (await connector.getProvider()) as EIP1193Provider
      const adapter = await createViemAdapterFromProvider({ provider })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let result: any
      if (isRetry && lastResultRef.current) {
        setIsRetrying(true)
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        result = await bridgeKit.retry(lastResultRef.current, { from: adapter, to: adapter })
        setIsRetrying(false)
      } else {
        result = await bridgeKit.bridge({
          from: { adapter, chain: SOURCE_CHAIN_NAME },
          to: { adapter, chain: DEST_CHAIN_NAME, recipientAddress: effectiveRecipient },
          // Use exact decimal string — no toFixed on a float
          amount: amountForBridge,
        })
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      lastResultRef.current = result

      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (result.state === 'success') {
        setPhase('success')
        setTimeout(() => { void refetchSrc(); void refetchDst() }, 4000)
        toast.success('Bridge complete! USDC minted on Arbitrum Sepolia.')
      } else {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        const failedStep = result.steps?.find((s: { state: string }) => s.state === 'error') as
          | { name: string; error: unknown } | undefined
        if (failedStep) {
          const errStr = failedStep.error instanceof Error
            ? failedStep.error.message
            : JSON.stringify(failedStep.error ?? 'Unknown error')
          updateStep(failedStep.name as StepName, { state: 'error', error: errStr })
          setBridgeError(`Failed at ${failedStep.name}: ${errStr.slice(0, 100)}`)
        } else {
          setBridgeError('Bridge transfer failed. You can retry from where it stopped.')
        }
        setPhase('error')
      }
    } catch (err: unknown) {
      setIsRetrying(false)
      const msg = parseOnchainError(err)
      if (msg.includes('cancelled by user')) {
        setPhase('idle')
        setSteps(INITIAL_STEPS.map(s => ({ ...s })))
        return
      }
      setBridgeError(msg)
      setPhase('error')
    }
  }, [
    connector, isConnected, walletChainId, effectiveRecipient, amountForBridge,
    attachEvents, updateStep, switchChainAsync, refetchSrc, refetchDst,
  ])

  const handleReset = () => {
    setPhase('idle')
    setSteps(INITIAL_STEPS.map(s => ({ ...s })))
    setBridgeError(null)
    lastResultRef.current = null
    setAmountInput('')
  }

  const isInProgress = phase === 'bridging'
  const mintStep = steps.find(s => s.name === 'mint')

  return (
    <div className="flex flex-col gap-3">

      {/* Chain route */}
      <div className="flex items-center gap-2">
        <ChainPill chainId={SOURCE_CHAIN.id} label="Ethereum Sepolia" role="from" />
        <div className="flex-1 flex justify-center">
          <ArrowDown className="size-4" style={{ color: 'var(--subtle)' }} />
        </div>
        <ChainPill chainId={DEST_CHAIN.id} label="Arbitrum Sepolia" role="to" />
      </div>

      {/* Balances */}
      {isConnected && (
        <div className="rounded-2xl p-3" style={{ background: 'var(--surface-muted)' }}>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs" style={{ color: 'var(--subtle)' }}>Sepolia USDC</p>
              <p className="font-semibold tabular-nums text-sm" style={{ color: 'var(--ink)' }}>
                {srcLoading ? '…' : srcFormatted ?? '—'}
              </p>
            </div>
            <ArrowDown className="size-4" style={{ color: 'var(--subtle)' }} />
            <div className="text-right">
              <p className="text-xs" style={{ color: 'var(--subtle)' }}>Arbitrum USDC</p>
              <p className="font-semibold tabular-nums text-sm" style={{ color: 'var(--ink)' }}>
                {dstLoading ? '…' : dstFormatted ?? '—'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Amount input */}
      <div
        className="rounded-2xl p-4"
        style={{
          background: 'var(--surface-strong)',
          border: `1px solid ${amountError ? 'var(--danger)' : 'var(--border)'}`,
        }}
      >
        <input
          inputMode="decimal"
          value={amountInput}
          onChange={e => {
            const v = e.target.value.replace(/[^0-9.]/g, '')
            if (v === '' || /^\d*\.?\d*$/.test(v)) setAmountInput(v)
          }}
          placeholder="0.000000"
          disabled={isInProgress}
          className="display w-full bg-transparent text-4xl font-bold tabular-nums outline-none placeholder:opacity-30 disabled:opacity-50"
          style={{ color: 'var(--ink)' }}
        />
        <div className="mt-2 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <TokenUSDC variant="branded" size={16} />
            <span className="text-sm font-medium" style={{ color: 'var(--muted)' }}>USDC</span>
          </div>
          {isConnected && rawSourceBalance != null && (
            <button
              disabled={isInProgress}
              onClick={() => {
                setAmountInput(
                  Amount.fromRaw(rawSourceBalance, usdcDecimalsFor(SOURCE_CHAIN.id)).toString()
                )
              }}
              className="text-xs font-semibold disabled:opacity-40"
              style={{ color: 'var(--accent)' }}
            >
              {srcLoading ? 'Loading…' : `Balance: ${srcFormatted} — Max`}
            </button>
          )}
        </div>
        {amountError && (
          <p className="mt-2 text-xs font-medium" style={{ color: 'var(--danger)' }}>{amountError}</p>
        )}
      </div>

      {/* Recipient */}
      <div
        className="rounded-2xl p-3"
        style={{
          background: 'var(--surface-strong)',
          border: `1px solid ${effectiveRecipient && !isAddressValid ? 'var(--danger)' : 'var(--border)'}`,
        }}
      >
        <p className="text-xs font-medium mb-1.5" style={{ color: 'var(--subtle)' }}>
          Recipient on Arbitrum Sepolia
        </p>
        <input
          value={effectiveRecipient}
          onChange={e => setRecipientAddress(e.target.value.trim())}
          placeholder="0x…"
          disabled={isInProgress}
          className="mono w-full bg-transparent text-sm outline-none placeholder:opacity-30 disabled:opacity-50"
          style={{ color: 'var(--ink)' }}
          spellCheck={false}
        />
        {effectiveRecipient && !isAddressValid && (
          <p className="mt-1 text-xs" style={{ color: 'var(--danger)' }}>Invalid Ethereum address.</p>
        )}
      </div>

      {/* Fee and timing — honest, no hardcoded numbers */}
      <div
        className="rounded-xl px-3 py-2.5"
        style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}
      >
        <div className="flex items-center justify-between text-xs">
          <span style={{ color: 'var(--subtle)' }}>Bridge protocol fee</span>
          <span style={{ color: 'var(--muted)' }}>CCTP V2 — no protocol fee</span>
        </div>
        <div className="flex items-center justify-between text-xs mt-1">
          <span style={{ color: 'var(--subtle)' }}>Source gas</span>
          <span style={{ color: 'var(--muted)' }}>Sepolia ETH (approve + burn txs)</span>
        </div>
        <div className="flex items-center justify-between text-xs mt-1">
          <span style={{ color: 'var(--subtle)' }}>Destination gas</span>
          <span style={{ color: 'var(--muted)' }}>Your wallet signs the mint tx</span>
        </div>
        <div className="flex items-center justify-between text-xs mt-1">
          <span style={{ color: 'var(--subtle)' }}>Est. time</span>
          <span style={{ color: 'var(--muted)' }}>Varies — CCTP attestation latency</span>
        </div>
        <div className="flex items-center justify-between text-xs mt-1">
          <span style={{ color: 'var(--subtle)' }}>You receive</span>
          <span className="font-semibold tabular-nums" style={{ color: 'var(--accent)' }}>
            {isAmountReady && amountForBridge ? `${amountForBridge} USDC` : '—'}
          </span>
        </div>
      </div>

      {/* Wrong chain warning */}
      {isConnected && isOnWrongChain && phase === 'idle' && (
        <div
          className="rounded-xl px-3 py-2.5 flex items-center gap-2"
          style={{ background: 'rgba(232,109,122,0.12)', border: '1px solid var(--danger)' }}
        >
          <AlertTriangle className="size-4 flex-shrink-0" style={{ color: 'var(--danger)' }} />
          <p className="text-xs" style={{ color: 'var(--danger)' }}>
            Wallet is on chain {walletChainId}. Bridge will switch it to Ethereum Sepolia automatically.
          </p>
        </div>
      )}

      {/* Not connected hint */}
      {!isConnected && (
        <div
          className="rounded-xl px-3 py-2.5 flex items-center gap-2"
          style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}
        >
          <Wallet className="size-4 flex-shrink-0" style={{ color: 'var(--subtle)' }} />
          <p className="text-xs" style={{ color: 'var(--subtle)' }}>
            Connect an EVM browser wallet (MetaMask or similar) to bridge.
          </p>
        </div>
      )}

      {/* Faucet links */}
      {isConnected && srcFormatted === '0.000000' && !srcLoading && (
        <div
          className="rounded-xl px-3 py-2.5"
          style={{ background: 'rgba(172,198,233,0.08)', border: '1px solid var(--border)' }}
        >
          <p className="text-xs font-medium mb-1" style={{ color: 'var(--accent)' }}>
            No Sepolia USDC yet?
          </p>
          <div className="flex flex-col gap-1">
            <a
              href="https://faucet.circle.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs"
              style={{ color: 'var(--accent-hover)' }}
            >
              Circle USDC Faucet (Sepolia) <ExternalLink className="size-3" />
            </a>
            <a
              href="https://sepoliafaucet.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs"
              style={{ color: 'var(--muted)' }}
            >
              Sepolia ETH Faucet (gas) <ExternalLink className="size-3" />
            </a>
          </div>
        </div>
      )}

      {/* Progress steps */}
      {phase !== 'idle' && (
        <div
          className="rounded-2xl p-3 divide-y divide-white/10"
          style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}
        >
          <p className="text-xs font-semibold pb-2 uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
            Bridge Progress
          </p>
          {steps.map((step, i) => (
            <StepRow key={step.name} step={step} chainId={i < 3 ? SOURCE_CHAIN.id : DEST_CHAIN.id} />
          ))}
        </div>
      )}

      {/* Error state */}
      {phase === 'error' && bridgeError && (
        <div
          className="rounded-xl px-3 py-2.5"
          style={{ background: 'rgba(232,109,122,0.12)', border: '1px solid var(--danger)' }}
        >
          <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--danger)' }}>Bridge failed</p>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{bridgeError}</p>
          <p className="text-xs mt-1" style={{ color: 'var(--subtle)' }}>
            Check existing transaction receipts before retrying. Do not start a new transfer while settlement is uncertain.
          </p>
        </div>
      )}

      {/* Success state */}
      {phase === 'success' && (
        <div
          className="rounded-xl px-3 py-2.5"
          style={{ background: 'rgba(141,216,159,0.12)', border: '1px solid var(--success)' }}
        >
          <p className="text-xs font-semibold mb-0.5" style={{ color: 'var(--success)' }}>Bridge complete</p>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            USDC minted on Arbitrum Sepolia. Balances refreshing.
          </p>
          {mintStep?.txHash && (
            <a
              href={buildTxExplorerUrl(DEST_CHAIN.id, mintStep.txHash)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 mt-1.5 text-xs font-medium"
              style={{ color: 'var(--success)' }}
            >
              View mint on Arbiscan <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      )}

      {/* CTAs */}
      {phase === 'idle' && (
        <button
          disabled={!canBridge}
          onClick={() => void executeBridge(false)}
          className="w-full rounded-2xl py-3.5 text-sm font-semibold transition-all hover:scale-[1.01] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: 'var(--accent)', color: '#0d1b2f' }}
        >
          {!isConnected
            ? 'Connect wallet to bridge'
            : isOnWrongChain
            ? 'Switch to Sepolia and Bridge'
            : isAmountReady
            ? `Bridge ${amountForBridge} USDC`
            : 'Bridge USDC'}
        </button>
      )}

      {phase === 'bridging' && (
        <button disabled className="w-full rounded-2xl py-3.5 text-sm font-semibold flex items-center justify-center gap-2 opacity-80 cursor-not-allowed"
          style={{ background: 'var(--accent)', color: '#0d1b2f' }}>
          <Loader2 className="size-4 animate-spin" />
          {isRetrying ? 'Retrying…' : 'Bridging…'}
        </button>
      )}

      {phase === 'error' && (
        <div className="flex gap-2">
          <button
            onClick={() => void executeBridge(true)}
            className="flex-1 rounded-2xl py-3.5 text-sm font-semibold flex items-center justify-center gap-1.5 transition-all hover:scale-[1.01] active:scale-[0.99]"
            style={{ background: 'var(--accent)', color: '#0d1b2f' }}
          >
            <RefreshCw className="size-4" /> Retry
          </button>
          <button
            onClick={handleReset}
            className="rounded-2xl px-4 py-3.5 text-sm font-medium border transition-all hover:scale-[1.01] active:scale-[0.99]"
            style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}
          >
            Reset
          </button>
        </div>
      )}

      {phase === 'success' && (
        <button
          onClick={handleReset}
          className="w-full rounded-2xl py-3.5 text-sm font-semibold transition-all hover:scale-[1.01] active:scale-[0.99]"
          style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)', color: 'var(--ink)' }}
        >
          Bridge more USDC
        </button>
      )}

      {/* Wallet info footer */}
      {isConnected && address && (
        <p className="text-xs text-center" style={{ color: 'var(--subtle)' }}>
          Connected: <span className="mono">{formatAddress(address)}</span>
          {walletChainId && <> · Chain {walletChainId}</>}
        </p>
      )}
    </div>
  )
}

// --- Root App ---

export default function BridgeApp() {

  return (
    <div className="min-h-dvh flex flex-col items-center justify-start px-4 py-6">

      {/* Header */}
      <header className="w-full max-w-md flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <TokenUSDC variant="branded" size={28} />
          <span className="display font-semibold text-lg" style={{ color: 'var(--ink)' }}>
            USDC Bridge
          </span>
          <span
            className="text-xs px-2 py-0.5 rounded-full font-medium"
            style={{ background: 'rgba(141,216,159,0.15)', color: 'var(--success)' }}
          >
            testnet only
          </span>
        </div>
        <ConnectKitButton />
      </header>

      {/* Main card */}
      <div
        className="w-full max-w-md rounded-3xl p-5"
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          backdropFilter: 'blur(24px) saturate(180%)',
          WebkitBackdropFilter: 'blur(24px) saturate(180%)',
        }}
      >
        <BrowserWalletMode />
      </div>

      {/* Footer */}
      <div className="w-full max-w-md mt-4 flex flex-wrap items-center justify-center gap-3 text-xs" style={{ color: 'var(--subtle)' }}>
        <span>Powered by Circle CCTP V2</span>
        <span>·</span>
        <a
          href={`${SOURCE_FACTS.explorerBase}/address/${SOURCE_USDC.address}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 hover:opacity-80"
        >
          Sepolia USDC <ExternalLink className="size-3" />
        </a>
        <span>·</span>
        <a
          href={`${DEST_FACTS.explorerBase}/address/${DEST_USDC.address}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 hover:opacity-80"
        >
          Arbitrum USDC <ExternalLink className="size-3" />
        </a>
      </div>
    </div>
  )
}

# Disciplr Soroban Contracts

On-chain programmable, time-locked capital vaults for accountability staking,
the chain-side counterpart to the `disciplr-backend` API and Horizon listener.

## Workspace layout

```text
contracts/
├── Cargo.toml                       # workspace manifest (soroban-sdk = "23")
├── README.md
└── accountability_vault/
    ├── Cargo.toml
    └── src/
        ├── lib.rs                   # AccountabilityVault contract
        └── test.rs                  # unit tests (testutils)
```

## accountability_vault

Implements the vault lifecycle that the backend models off-chain in
`src/services/vaultTransitions.ts` and parses events for in
`src/services/eventParser.ts`:

| Function | Purpose |
|---|---|
| `create_vault` | Create a `Draft` vault with milestones, verifier, and success/failure destinations. Validates amount, deadline, and that milestone amounts sum to the total. |
| `stake` | Creator transfers the SEP-41 token into the contract; `Draft` -> `Active`. |
| `check_in` | Designated verifier confirms a milestone before its `due_date`. |
| `slash_on_miss` | After the deadline with unverified milestones, slash funds to `failure_destination`; `Active` -> `Failed`. |
| `claim` | When all milestones are verified, release funds to `success_destination`; `Active` -> `Completed`. |
| `withdraw` | Cancel/refund an unfunded or unstarted vault to the creator; -> `Cancelled`. |
| `get_vault` | Read-only accessor for the current vault record. |

The `VaultStatus` enum (`Draft`/`Active`/`Completed`/`Failed`/`Cancelled`)
mirrors `PersistedVault.status` in `src/types/vaults.ts`. Emitted events
(`vault_created`, `vault_staked`, `vault_funded`, `milestone_checked_in`, `vault_slashed`,
`vault_completed`, `vault_cancelled`, `vault_withdrawn`) align with the topics
consumed by the backend event parser.

### Event reference

| Event | Topics | Data | Notes |
|---|---|---|---|
| `vault_created` | `(vault_created, creator)` | `amount` | Emitted by `create_vault`. |
| `vault_staked` | `(vault_staked, from)` | `amount` | Legacy funding event; preserved for backward-compatible listeners. |
| `vault_funded` | `(vault_funded, token, from)` | `net_staked_amount` | Rich funding event emitted alongside `vault_staked`. Carries the SEP-41 token address so `eventParser.ts` can reconcile the contract address without a separate Horizon query. |
| `milestone_checked_in` | `(milestone_checked_in, caller, source)` | `milestone_index` | `source` is `"verifier"` or `"oracle"`. |
| `vault_slashed` | `(vault_slashed, failure_destination)` | `slashed_amount` | Emitted by `slash_on_miss`. |
| `vault_completed` | `(vault_completed, success_destination)` | `released_amount` | Emitted by `claim`. |
| `vault_cancelled` | `(vault_cancelled, creator)` | `0` | Emitted by `cancel_vault` or `withdraw` on Draft. |
| `vault_withdrawn` | `(vault_withdrawn, creator)` | `refunded_amount` | Emitted by `withdraw` on Active. |

## Build & test

```bash
# from the contracts/ directory
stellar contract build
cargo test

# Check that the compiled contract stays within the allowed size budget
# Fails if the .wasm artifact exceeds the 100KB budget (configurable via MAX_WASM_SIZE)
bash build-size-check.sh
```

### Wasm Size Budget Configuration

To prevent accidental bloat in the smart contract, the `accountability_vault` includes a size budget check (`build-size-check.sh`) integrated into the CI pipeline.
The default limit is set to **100,000 bytes** (~100KB).

If you need to update this budget as the contract grows:
1. Temporarily increase the budget locally by exporting the variable: `export MAX_WASM_SIZE=150000`
2. Update the default value in `contracts/build-size-check.sh`
3. Push the changes to update the CI limit.

## Backend integration

`src/services/soroban.ts` calls `create_vault` via the Stellar SDK
(`@stellar/stellar-sdk` v14). The Horizon listener
(`src/services/horizonListener.ts`) and `src/services/eventParser.ts`
ingest the events emitted by these functions to keep the off-chain vault state
in sync.

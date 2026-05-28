#![no_std]
//! Disciplr Accountability Vault
//!
//! A Soroban smart contract implementing programmable time-locked capital vaults
//! for accountability staking. A creator stakes funds toward a goal with one or
//! more milestones. A designated verifier confirms check-ins / milestone
//! completion. On success the staked capital is released to the
//! `success_destination`; on a missed deadline the capital is slashed to the
//! `failure_destination` (e.g. a charity or forfeit address).
//!
//! Lifecycle: create_vault -> stake -> (check_in)* -> claim | slash_on_miss
//! Funds movement is modeled via the SEP-41 token client (`stake`, `claim`,
//! `slash_on_miss`, `withdraw`). The contract enforces the state machine,
//! authorization, and deadline rules on-chain.

/// Error types for the accountability vault contract
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Error {
    /// Invalid amount provided (negative or zero)
    InvalidAmount = 1,
    /// Milestone amounts do not sum to the total vault amount
    AmountMismatch = 2,
    /// Overflow occurred during amount summation
    Overflow = 3,
}

/// Milestone structure
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Milestone {
    pub id: u64,
    pub title: String,
    pub amount: i128,
    pub due_date: u64,
    /// Whether the verifier has confirmed this milestone.
    pub verified: bool,
}

/// Vault structure
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Vault {
    pub creator: Address,
    /// The party authorized to confirm check-ins / milestones.
    pub verifier: Address,
    /// SEP-41 token used for staking.
    pub token: Address,
    /// Total staked amount (sum of milestone amounts).
    pub amount: i128,
    /// Amount actually transferred into the contract via `stake`.
    pub staked: i128,
    /// Destination for released funds on success.
    pub success_destination: Address,
    /// Destination for slashed funds on a missed deadline.
    pub failure_destination: Address,
    /// Overall vault deadline (seconds since epoch, UTC).
    pub end_timestamp: u64,
    pub status: VaultStatus,
    pub milestones: Vec<Milestone>,
}

/// Errors surfaced to callers. Numbered for stable client mapping.
#[contracterror]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidAmount = 3,
    InvalidDeadline = 4,
    NoMilestones = 5,
    NotDraft = 6,
    NotActive = 7,
    Unauthorized = 8,
    AlreadyStaked = 9,
    MilestoneIndexOutOfRange = 10,
    MilestoneAlreadyVerified = 11,
    DeadlinePassed = 12,
    DeadlineNotReached = 13,
    MilestonesIncomplete = 14,
    NothingToWithdraw = 15,
    AmountMismatch = 16,
}

#[contract]
pub struct AccountabilityVault;

#[contractimpl]
impl Contract {
    /// Creates a new accountability vault with the specified parameters.
    ///
    /// Validates that the staked amount is positive, the deadline is in the
    /// future, milestone amounts sum to `amount`, and that there is at least one
    /// milestone. The creator must authorize the call.
    pub fn create_vault(
        env: Env,
        creator: Address,
        verifier: Address,
        token: Address,
        amount: i128,
        verifier: String,
        success_destination: String,
        failure_destination: String,
        milestones: Vec<Milestone>,
    ) -> Result<Vault, Error> {
        // Validate total amount
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        // Validate individual milestone amounts
        for milestone in milestones.iter() {
            if milestone.amount <= 0 {
                return Err(Error::InvalidAmount);
            }
        }

        // Sum milestone amounts using checked_add to prevent overflow
        // This is the critical overflow-safe summation as required by issue #361
        let mut sum: i128 = 0;
        for milestone in milestones.iter() {
            // Use checked_add to detect overflow and return typed error instead of panicking
            sum = match sum.checked_add(milestone.amount) {
                Some(result) => result,
                None => {
                    // Overflow occurred - return typed error instead of panicking
                    return Err(Error::Overflow);
                }
            };
        }

        // Verify that milestone amounts sum to the total vault amount
        // This invariant must be maintained: sum == amount
        if sum != amount {
            return Err(Error::AmountMismatch);
        }

        // Create and return the vault
        let vault = Vault {
            creator: creator.clone(),
            verifier,
            token,
            amount,
            verifier,
            success_destination,
            failure_destination,
            milestones,
        };
        env.storage().instance().set(&DataKey::Vault, &vault);
        env.events()
            .publish((String::from_str(&env, "vault_created"), creator), amount);
        Ok(())
    }

    /// Funds the vault by transferring `amount` of the staking token from the
    /// creator into the contract, moving the vault from `Draft` to `Active`.
    pub fn stake(env: Env, from: Address) -> Result<(), Error> {
        from.require_auth();
        let mut vault: Vault = Self::load(&env)?;

        if vault.status != VaultStatus::Draft {
            return Err(Error::NotDraft);
        }
        if from != vault.creator {
            return Err(Error::Unauthorized);
        }
        if vault.staked != 0 {
            return Err(Error::AlreadyStaked);
        }

        let client = token::Client::new(&env, &vault.token);
        client.transfer(&from, &env.current_contract_address(), &vault.amount);

        vault.staked = vault.amount;
        vault.status = VaultStatus::Active;
        env.storage().instance().set(&DataKey::Vault, &vault);
        env.events()
            .publish((String::from_str(&env, "vault_staked"), from), vault.amount);
        Ok(())
    }

    /// Records a verifier check-in confirming a milestone before its due date.
    /// Only the designated verifier may call this on an `Active` vault.
    pub fn check_in(env: Env, verifier: Address, milestone_index: u32) -> Result<(), Error> {
        verifier.require_auth();
        let mut vault: Vault = Self::load(&env)?;

        if vault.status != VaultStatus::Active {
            return Err(Error::NotActive);
        }
        if verifier != vault.verifier {
            return Err(Error::Unauthorized);
        }
        if milestone_index >= vault.milestones.len() {
            return Err(Error::MilestoneIndexOutOfRange);
        }

        let mut milestone = vault.milestones.get(milestone_index).unwrap();
        if milestone.verified {
            return Err(Error::MilestoneAlreadyVerified);
        }
        if env.ledger().timestamp() > milestone.due_date {
            return Err(Error::DeadlinePassed);
        }

        milestone.verified = true;
        vault.milestones.set(milestone_index, milestone);
        env.storage()
            .instance()
            .set(&DataKey::CheckIn(milestone_index), &env.ledger().timestamp());
        env.storage().instance().set(&DataKey::Vault, &vault);
        env.events().publish(
            (String::from_str(&env, "milestone_checked_in"), verifier),
            milestone_index,
        );
        Ok(())
    }

    /// Slashes the staked capital to the `failure_destination` once the vault
    /// deadline has passed and not all milestones were verified. Permissionless:
    /// anyone may trigger the slash after the deadline (e.g. a backend keeper).
    pub fn slash_on_miss(env: Env) -> Result<(), Error> {
        let mut vault: Vault = Self::load(&env)?;

        if vault.status != VaultStatus::Active {
            return Err(Error::NotActive);
        }
        if env.ledger().timestamp() <= vault.end_timestamp {
            return Err(Error::DeadlineNotReached);
        }
        if Self::all_verified(&vault) {
            return Err(Error::MilestonesIncomplete);
        }

        let client = token::Client::new(&env, &vault.token);
        client.transfer(
            &env.current_contract_address(),
            &vault.failure_destination,
            &vault.staked,
        );

        vault.status = VaultStatus::Failed;
        let slashed = vault.staked;
        vault.staked = 0;
        env.storage().instance().set(&DataKey::Vault, &vault);
        env.events().publish(
            (
                String::from_str(&env, "vault_slashed"),
                vault.failure_destination.clone(),
            ),
            slashed,
        );
        Ok(())
    }

    /// Releases the staked capital to the `success_destination` once every
    /// milestone has been verified. Callable by the creator or verifier.
    pub fn claim(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        let mut vault: Vault = Self::load(&env)?;

        if vault.status != VaultStatus::Active {
            return Err(Error::NotActive);
        }
        if caller != vault.creator && caller != vault.verifier {
            return Err(Error::Unauthorized);
        }
        if !Self::all_verified(&vault) {
            return Err(Error::MilestonesIncomplete);
        }

        let client = token::Client::new(&env, &vault.token);
        client.transfer(
            &env.current_contract_address(),
            &vault.success_destination,
            &vault.staked,
        );

        vault.status = VaultStatus::Completed;
        let released = vault.staked;
        vault.staked = 0;
        env.storage().instance().set(&DataKey::Vault, &vault);
        env.events().publish(
            (
                String::from_str(&env, "vault_completed"),
                vault.success_destination.clone(),
            ),
            released,
        );
        Ok(())
    }

    /// Cancels an unfunded (`Draft`) vault, or refunds the creator if the vault
    /// was funded but never activated against any milestone. Only the creator
    /// may withdraw; activated vaults with verified check-ins cannot be unwound.
    pub fn withdraw(env: Env, creator: Address) -> Result<(), Error> {
        creator.require_auth();
        let mut vault: Vault = Self::load(&env)?;

        if creator != vault.creator {
            return Err(Error::Unauthorized);
        }
        if vault.status == VaultStatus::Draft {
            vault.status = VaultStatus::Cancelled;
            env.storage().instance().set(&DataKey::Vault, &vault);
            env.events()
                .publish((String::from_str(&env, "vault_cancelled"), creator), 0i128);
            return Ok(());
        }

        if vault.status != VaultStatus::Active {
            return Err(Error::NotActive);
        }
        if Self::any_verified(&vault) {
            return Err(Error::Unauthorized);
        }
        if vault.staked <= 0 {
            return Err(Error::NothingToWithdraw);
        }

        let client = token::Client::new(&env, &vault.token);
        client.transfer(&env.current_contract_address(), &creator, &vault.staked);

        let refunded = vault.staked;
        vault.staked = 0;
        vault.status = VaultStatus::Cancelled;
        env.storage().instance().set(&DataKey::Vault, &vault);
        env.events().publish(
            (String::from_str(&env, "vault_withdrawn"), creator),
            refunded,
        );
        Ok(())
    }

    /// Read-only accessor returning the current vault record.
    pub fn get_vault(env: Env) -> Result<Vault, Error> {
        Self::load(&env)
    }

    // ── internal helpers ────────────────────────────────────────────────

    fn load(env: &Env) -> Result<Vault, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Vault)
            .ok_or(Error::NotInitialized)
    }

    fn all_verified(vault: &Vault) -> bool {
        for m in vault.milestones.iter() {
            if !m.verified {
                return false;
            }
        }
        true
    }

    fn any_verified(vault: &Vault) -> bool {
        for m in vault.milestones.iter() {
            if m.verified {
                return true;
            }
        }
        false
    }
}

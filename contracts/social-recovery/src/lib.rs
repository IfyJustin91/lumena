#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Vec,
};

/// Storage keys for the social recovery contract.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Per-account configuration keyed by the account (owner) address.
    Config(Address),
    /// Active recovery proposal keyed by the account (owner) address.
    Proposal(Address),
}

/// Per-account guardian configuration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountConfig {
    /// Registered guardian addresses.
    pub guardians: Vec<Address>,
    /// M-of-N threshold required to execute a recovery.
    pub threshold: u32,
    /// Timelock (grace period) in seconds before a recovery can be executed.
    pub timelock_seconds: u64,
    /// The current owner key (e.g. a passkey / device key identifier).
    pub current_owner_key: Address,
}

/// A pending recovery proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveryProposal {
    /// The new owner key that will replace the current one upon execution.
    pub new_key: Address,
    /// Guardians that have voted in favour of this proposal.
    pub votes: Vec<Address>,
    /// Ledger timestamp (seconds) at which the proposal was initiated.
    pub initiated_at: u64,
    /// Whether the proposal has already been executed.
    pub executed: bool,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// No configuration registered for this account.
    NotRegistered = 1,
    /// Caller is not the owner of the account.
    NotOwner = 2,
    /// Caller is not a registered guardian.
    NotGuardian = 3,
    /// Threshold must be greater than zero and not exceed the guardian count.
    InvalidThreshold = 4,
    /// Guardian list must not be empty.
    NoGuardians = 5,
    /// A recovery proposal is already active for this account.
    ProposalExists = 6,
    /// No active recovery proposal for this account.
    NoProposal = 7,
    /// The proposal has already been executed.
    AlreadyExecuted = 8,
    /// The timelock has not yet elapsed.
    TimelockNotElapsed = 9,
    /// Not enough guardian votes to execute.
    ThresholdNotMet = 10,
    /// The guardian has already voted on this proposal.
    AlreadyVoted = 11,
    /// The new key must differ from the current owner key.
    SameKey = 12,
}

#[contract]
pub struct SocialRecoveryContract;

#[contractimpl]
impl SocialRecoveryContract {
    /// Register (or replace) the guardian configuration for the calling owner.
    ///
    /// The owner must authenticate. `guardians` is the set of N guardian
    /// addresses, `threshold` is M, and `timelock_seconds` is the grace period
    /// that must elapse before a recovery can be executed.
    pub fn register_guardians(
        env: Env,
        owner: Address,
        guardians: Vec<Address>,
        threshold: u32,
        timelock_seconds: u64,
        current_owner_key: Address,
    ) -> Result<(), Error> {
        owner.require_auth();

        let n = guardians.len();
        if n == 0 {
            return Err(Error::NoGuardians);
        }
        if threshold == 0 || threshold > n {
            return Err(Error::InvalidThreshold);
        }

        let config = AccountConfig {
            guardians,
            threshold,
            timelock_seconds,
            current_owner_key,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Config(owner.clone()), &config);

        env.events().publish(
            (symbol_short!("guardians"), symbol_short!("register")),
            (owner, config.threshold, config.timelock_seconds),
        );
        Ok(())
    }

    /// Initiate a recovery proposal to rotate the owner key to `new_key`.
    ///
    /// Must be called by a registered guardian. The initiating guardian is
    /// automatically counted as the first vote.
    pub fn initiate_recovery(
        env: Env,
        owner: Address,
        guardian: Address,
        new_key: Address,
    ) -> Result<(), Error> {
        guardian.require_auth();

        let config = Self::load_config(&env, &owner)?;
        if !Self::is_guardian(&config, &guardian) {
            return Err(Error::NotGuardian);
        }
        if new_key == config.current_owner_key {
            return Err(Error::SameKey);
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::Proposal(owner.clone()))
        {
            return Err(Error::ProposalExists);
        }

        let mut votes = Vec::new(&env);
        votes.push_back(guardian.clone());

        let proposal = RecoveryProposal {
            new_key: new_key.clone(),
            votes,
            initiated_at: env.ledger().timestamp(),
            executed: false,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(owner.clone()), &proposal);

        env.events().publish(
            (symbol_short!("recovery"), symbol_short!("initiate")),
            (owner, guardian, new_key, proposal.initiated_at),
        );
        Ok(())
    }

    /// Cast a guardian vote in favour of the active recovery proposal.
    ///
    /// Idempotent per guardian: a guardian may only vote once per proposal.
    pub fn vote_recovery(
        env: Env,
        owner: Address,
        guardian: Address,
    ) -> Result<(), Error> {
        guardian.require_auth();

        let config = Self::load_config(&env, &owner)?;
        if !Self::is_guardian(&config, &guardian) {
            return Err(Error::NotGuardian);
        }

        let mut proposal = Self::load_proposal(&env, &owner)?;
        if proposal.executed {
            return Err(Error::AlreadyExecuted);
        }
        if Self::has_voted(&proposal, &guardian) {
            return Err(Error::AlreadyVoted);
        }

        proposal.votes.push_back(guardian.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(owner.clone()), &proposal);

        env.events().publish(
            (symbol_short!("recovery"), symbol_short!("vote")),
            (owner, guardian, proposal.votes.len()),
        );
        Ok(())
    }

    /// Execute the active recovery proposal, rotating the owner key.
    ///
    /// Requires at least M guardian votes and that the timelock has elapsed
    /// since the proposal was initiated.
    pub fn execute_recovery(env: Env, owner: Address) -> Result<Address, Error> {
        let mut config = Self::load_config(&env, &owner)?;
        let mut proposal = Self::load_proposal(&env, &owner)?;

        if proposal.executed {
            return Err(Error::AlreadyExecuted);
        }
        if proposal.votes.len() < config.threshold {
            return Err(Error::ThresholdNotMet);
        }

        let now = env.ledger().timestamp();
        let unlock_at = proposal.initiated_at.saturating_add(config.timelock_seconds);
        if now < unlock_at {
            return Err(Error::TimelockNotElapsed);
        }

        let new_key = proposal.new_key.clone();
        config.current_owner_key = new_key.clone();
        proposal.executed = true;

        env.storage()
            .persistent()
            .set(&DataKey::Config(owner.clone()), &config);
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(owner.clone()), &proposal);

        env.events().publish(
            (symbol_short!("recovery"), symbol_short!("execute")),
            (owner, new_key.clone(), now),
        );
        Ok(new_key)
    }

    /// Cancel the active recovery proposal. Only the legitimate owner may
    /// cancel, and only before the proposal has been executed.
    pub fn cancel_recovery(env: Env, owner: Address) -> Result<(), Error> {
        owner.require_auth();

        let mut proposal = Self::load_proposal(&env, &owner)?;
        if proposal.executed {
            return Err(Error::AlreadyExecuted);
        }

        proposal.executed = true;
        env.storage()
            .persistent()
            .set(&DataKey::Proposal(owner.clone()), &proposal);

        env.events().publish(
            (symbol_short!("recovery"), symbol_short!("cancel")),
            (owner, env.ledger().timestamp()),
        );
        Ok(())
    }

    /// Read the guardian configuration for an account.
    pub fn get_config(env: Env, owner: Address) -> Result<AccountConfig, Error> {
        Self::load_config(&env, &owner)
    }

    /// Read the active recovery proposal for an account, if any.
    pub fn get_proposal(env: Env, owner: Address) -> Result<RecoveryProposal, Error> {
        Self::load_proposal(&env, &owner)
    }

    // ----- Internal helpers -----

    fn load_config(env: &Env, owner: &Address) -> Result<AccountConfig, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Config(owner.clone()))
            .ok_or(Error::NotRegistered)
    }

    fn load_proposal(env: &Env, owner: &Address) -> Result<RecoveryProposal, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Proposal(owner.clone()))
            .ok_or(Error::NoProposal)
    }

    fn is_guardian(config: &AccountConfig, guardian: &Address) -> bool {
        config.guardians.iter().any(|g| g == *guardian)
    }

    fn has_voted(proposal: &RecoveryProposal, guardian: &Address) -> bool {
        proposal.votes.iter().any(|v| v == *guardian)
    }
}

#[cfg(test)]
mod test;
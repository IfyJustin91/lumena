#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Symbol, Vec,
};

/// Number of seconds in a rolling window (24 hours).
const WINDOW_SECONDS: u64 = 24 * 60 * 60;

/// Delay applied to master-key limit changes (24 hours).
const LIMIT_CHANGE_DELAY: u64 = 24 * 60 * 60;

/// Maximum number of spend entries kept per (asset, account) window.
const MAX_ENTRIES: u32 = 64;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    Unauthorized = 3,
    ExceedsAllowance = 4,
    InvalidAmount = 5,
    NoPendingLimit = 6,
    DelayNotElapsed = 7,
    TooManyEntries = 8,
    TimelockNotExpired = 9,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpendEntry {
    pub timestamp: u64,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingLimit {
    pub limit: i128,
    pub effective_time: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Master,
    Limit(Address, Address),
    Pending(Address, Address),
    Spends(Address, Address),
}

#[contract]
pub struct SpendPolicyContract;

#[contractimpl]
impl SpendPolicyContract {
    /// Initialize the contract with the master key that can adjust limits.
    pub fn initialize(env: Env, master: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Master) {
            return Err(Error::AlreadyInitialized);
        }
        master.require_auth();
        env.storage().instance().set(&DataKey::Master, &master);
        Ok(())
    }

    /// Return the current master key.
    pub fn master(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Master)
            .ok_or(Error::NotInitialized)
    }

    /// Set the daily limit for (asset, account) immediately. Only the master
    /// key may call this. Intended for initial configuration.
    pub fn set_limit(
        env: Env,
        asset: Address,
        account: Address,
        limit: i128,
    ) -> Result<(), Error> {
        let master = Self::master(env.clone())?;
        master.require_auth();
        if limit < 0 {
            return Err(Error::InvalidAmount);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Limit(asset, account), &limit);
        Ok(())
    }

    /// Get the currently active daily limit for (asset, account).
    pub fn get_limit(env: Env, asset: Address, account: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Limit(asset, account))
            .unwrap_or(0)
    }

    /// Schedule a limit change that takes effect 24 hours from now.
    pub fn schedule_limit(
        env: Env,
        asset: Address,
        account: Address,
        limit: i128,
    ) -> Result<(), Error> {
        let master = Self::master(env.clone())?;
        master.require_auth();
        if limit < 0 {
            return Err(Error::InvalidAmount);
        }
        let effective_time = env.ledger().timestamp() + LIMIT_CHANGE_DELAY;
        let pending = PendingLimit {
            limit,
            effective_time,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Pending(asset, account), &pending);
        Ok(())
    }

    /// Get the pending limit change for (asset, account), if any.
    pub fn get_pending_limit(
        env: Env,
        asset: Address,
        account: Address,
    ) -> Option<PendingLimit> {
        env.storage()
            .persistent()
            .get(&DataKey::Pending(asset, account))
    }

    /// Apply a scheduled limit change once its 24-hour delay has elapsed.
    pub fn apply_pending_limit(
        env: Env,
        asset: Address,
        account: Address,
    ) -> Result<i128, Error> {
        let pending: PendingLimit = env
            .storage()
            .persistent()
            .get(&DataKey::Pending(asset, account))
            .ok_or(Error::NoPendingLimit)?;

        if env.ledger().timestamp() < pending.effective_time {
            return Err(Error::TimelockNotExpired);
        }

        env.storage()
            .persistent()
            .set(&DataKey::Limit(asset, account), &pending.limit);
        env.storage()
            .persistent()
            .remove(&DataKey::Pending(asset, account));
        Ok(pending.limit)
    }

    /// Compute the amount consumed within the rolling 24-hour window.
    pub fn consumed(env: Env, asset: Address, account: Address) -> i128 {
        let now = env.ledger().timestamp();
        let entries = Self::pruned_entries(&env, &asset, &account, now);
        let mut total: i128 = 0;
        for entry in entries.iter() {
            total += entry.amount;
        }
        total
    }

    /// Compute the remaining allowance within the rolling 24-hour window.
    pub fn remaining(env: Env, asset: Address, account: Address) -> i128 {
        let limit = Self::get_limit(env.clone(), asset.clone(), account.clone());
        let consumed = Self::consumed(env, asset, account);
        let remaining = limit - consumed;
        if remaining < 0 {
            0
        } else {
            remaining
        }
    }

    /// Record a spend for (asset, account), enforcing the rolling 24-hour limit.
    pub fn spend(
        env: Env,
        asset: Address,
        account: Address,
        amount: i128,
    ) -> Result<i128, Error> {
        account.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let now = env.ledger().timestamp();
        let limit = Self::get_limit(env.clone(), asset.clone(), account.clone());

        let mut entries = Self::pruned_entries(&env, &asset, &account, now);
        let mut consumed: i128 = 0;
        for entry in entries.iter() {
            consumed += entry.amount;
        }

        let remaining = limit - consumed;
        if amount > remaining {
            return Err(Error::ExceedsAllowance);
        }

        if entries.len() >= MAX_ENTRIES {
            return Err(Error::TooManyEntries);
        }

        entries.push_back(SpendEntry {
            timestamp: now,
            amount,
        });

        env.storage()
            .persistent()
            .set(&DataKey::Spends(asset.clone(), account.clone()), &entries);

        env.events().publish(
            (symbol_short!("spend"), asset, account),
            (amount, now),
        );

        Ok(remaining - amount)
    }

    /// Read the stored entries for (asset, account), dropping any that fall
    /// outside the rolling 24-hour window ending at `now`.
    fn pruned_entries(
        env: &Env,
        asset: &Address,
        account: &Address,
        now: u64,
    ) -> Vec<SpendEntry> {
        let stored: Vec<SpendEntry> = env
            .storage()
            .persistent()
            .get(&DataKey::Spends(asset.clone(), account.clone()))
            .unwrap_or_else(|| Vec::new(env));

        let cutoff = now.saturating_sub(WINDOW_SECONDS);
        let mut pruned: Vec<SpendEntry> = Vec::new(env);
        for entry in stored.iter() {
            // Keep entries strictly newer than the cutoff so that exactly
            // 24 hours of history is retained.
            if entry.timestamp > cutoff {
                pruned.push_back(entry);
            }
        }
        pruned
    }
}

mod test;

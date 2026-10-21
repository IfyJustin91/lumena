#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, Symbol,
};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Owner,
    EpochLength,
    Deposit(Address, Address),
    Spent(Address, Address, u32),
    SpendLimit(Address, Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PaymasterError {
    InvalidAmount = 1,
    InsufficientDeposit = 2,
    SpendLimitExceeded = 3,
    Unauthorized = 4,
    FeeExceedsMax = 5,
}

#[contract]
pub struct Paymaster;

#[contractimpl]
impl Paymaster {
    pub fn initialize(env: Env, owner: Address, epoch_length: u32) {
        if env.storage().instance().has(&DataKey::Owner) {
            panic!("already initialized");
        }
        owner.require_auth();
        env.storage().instance().set(&DataKey::Owner, &owner);
        env.storage()
            .instance()
            .set(&DataKey::EpochLength, &epoch_length);
    }

    pub fn owner(env: Env) -> Address {
        env.storage().instance().get(&DataKey::Owner).unwrap()
    }

    pub fn epoch_length(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::EpochLength)
            .unwrap()
    }

    pub fn current_epoch(env: Env) -> u32 {
        let epoch_length = Self::epoch_length(env.clone());
        if epoch_length == 0 {
            return 0;
        }
        env.ledger().sequence() / epoch_length
    }

    pub fn set_spend_limit(env: Env, user: Address, token: Address, limit: i128) {
        let owner: Address = env.storage().instance().get(&DataKey::Owner).unwrap();
        owner.require_auth();
        if limit < 0 {
            panic!("invalid limit");
        }
        env.storage()
            .persistent()
            .set(&DataKey::SpendLimit(user, token), &limit);
    }

    pub fn spend_limit(env: Env, user: Address, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::SpendLimit(user, token))
            .unwrap_or(0)
    }

    pub fn spent_this_epoch(env: Env, user: Address, token: Address) -> i128 {
        let epoch = Self::current_epoch(env.clone());
        env.storage()
            .persistent()
            .get(&DataKey::Spent(user, token, epoch))
            .unwrap_or(0)
    }

    pub fn deposit_balance(env: Env, sponsor: Address, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Deposit(sponsor, token))
            .unwrap_or(0)
    }

    pub fn deposit(env: Env, sponsor: Address, token: Address, amount: i128) -> i128 {
        sponsor.require_auth();
        if amount <= 0 {
            panic!("invalid amount");
        }

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&sponsor, &env.current_contract_address(), &amount);

        let key = DataKey::Deposit(sponsor.clone(), token.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let updated = current + amount;
        env.storage().persistent().set(&key, &updated);

        updated
    }

    pub fn sponsor_invocation(
        env: Env,
        sponsor: Address,
        user: Address,
        _contract: Address,
        _function_name: Symbol,
        token: Address,
        max_fee: i128,
    ) -> Result<i128, PaymasterError> {
        sponsor.require_auth();

        if max_fee <= 0 {
            return Err(PaymasterError::InvalidAmount);
        }

        let deposit_key = DataKey::Deposit(sponsor.clone(), token.clone());
        let balance: i128 = env.storage().persistent().get(&deposit_key).unwrap_or(0);
        if balance < max_fee {
            return Err(PaymasterError::InsufficientDeposit);
        }

        let epoch = Self::current_epoch(env.clone());
        let spent_key = DataKey::Spent(user.clone(), token.clone(), epoch);
        let spent: i128 = env.storage().persistent().get(&spent_key).unwrap_or(0);
        let limit: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::SpendLimit(user.clone(), token.clone()))
            .unwrap_or(0);

        if limit > 0 && spent + max_fee > limit {
            return Err(PaymasterError::SpendLimitExceeded);
        }

        env.storage()
            .persistent()
            .set(&deposit_key, &(balance - max_fee));
        env.storage()
            .persistent()
            .set(&spent_key, &(spent + max_fee));

        env.events().publish(
            (symbol_short!("paymaster"), symbol_short!("sponsor")),
            (sponsor.clone(), user.clone(), token.clone(), max_fee, epoch),
        );

        Ok(max_fee)
    }

    pub fn withdraw(env: Env, token: Address, amount: i128) -> i128 {
        let owner: Address = env.storage().instance().get(&DataKey::Owner).unwrap();
        owner.require_auth();

        if amount <= 0 {
            panic!("invalid amount");
        }

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&env.current_contract_address(), &owner, &amount);

        amount
    }
}

//! Soroban Gas and Resource Footprint Profiling Suite
//!
//! Runs benchmarks against all Lumena Soroban contracts using the soroban-sdk
//! testutils budget API to record CPU instructions and memory bytes consumed
//! for typical operations.
//!
//! Run with:
//!   cargo run --package benchmarks --bin benchmarks
//!
//! Results are printed as a formatted table and saved to
//! `benchmark-results.json` for the web viewer.

extern crate std;

use std::time::{SystemTime, UNIX_EPOCH};
use std::{
    fs,
    process,
};

use benchmarks::{BenchmarkReport, BenchmarkResult};

// ── Budget thresholds ────────────────────────────────────────────────────────
//
// These values are conservative ceilings derived from manual baseline runs.
// Any invocation exceeding these limits will fail CI.
//
// Stellar Mainnet absolute limits (for reference):
//   CPU:    100_000_000 instructions per transaction
//   Memory: 41_943_040 bytes per transaction

/// CPU instruction budgets per benchmark operation.
mod cpu_budget {
    // SmartAccount
    pub const SMART_ACCOUNT_INIT: u64 = 500_000;
    pub const SMART_ACCOUNT_TRANSFER: u64 = 600_000;
    pub const SMART_ACCOUNT_QUERY: u64 = 200_000;

    // PaymasterContract
    pub const PAYMASTER_INITIALIZE: u64 = 400_000;
    pub const PAYMASTER_DEPOSIT: u64 = 600_000;
    pub const PAYMASTER_SET_SPEND_LIMIT: u64 = 400_000;
    pub const PAYMASTER_SPONSOR: u64 = 800_000;

    // SessionKeys
    pub const SESSION_REGISTER: u64 = 600_000;
    pub const SESSION_VALIDATE: u64 = 500_000;
    pub const SESSION_REVOKE: u64 = 400_000;
}

/// Memory byte budgets per benchmark operation.
mod mem_budget {
    pub const SMART_ACCOUNT_INIT: u64 = 2_000_000;
    pub const SMART_ACCOUNT_TRANSFER: u64 = 2_500_000;
    pub const SMART_ACCOUNT_QUERY: u64 = 1_000_000;

    pub const PAYMASTER_INITIALIZE: u64 = 1_500_000;
    pub const PAYMASTER_DEPOSIT: u64 = 2_000_000;
    pub const PAYMASTER_SET_SPEND_LIMIT: u64 = 1_500_000;
    pub const PAYMASTER_SPONSOR: u64 = 2_500_000;

    pub const SESSION_REGISTER: u64 = 2_000_000;
    pub const SESSION_VALIDATE: u64 = 1_500_000;
    pub const SESSION_REVOKE: u64 = 1_500_000;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Capture CPU instructions and memory bytes for the current env budget.
macro_rules! measure {
    ($env:expr) => {{
        let budget = $env.budget();
        (budget.cpu_instruction_cost(), budget.memory_bytes_cost())
    }};
}

// ── SmartAccount benchmarks ──────────────────────────────────────────────────

mod bench_smart_account {
    use super::*;
    use smart_account::{SmartAccount, SmartAccountClient};
    use soroban_sdk::{
        testutils::Address as _,
        token, Address, Env, Map,
    };

    fn setup_env() -> (Env, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        env.budget().reset_unlimited();

        let contract_id = env.register(SmartAccount, ());
        let owner = Address::generate(&env);
        let signer2 = Address::generate(&env);
        (env, contract_id, owner, signer2)
    }

    pub fn bench_init() -> BenchmarkResult {
        let (env, contract_id, owner, signer2) = setup_env();
        let client = SmartAccountClient::new(&env, &contract_id);

        let mut signers = Map::new(&env);
        signers.set(owner.clone(), 1u32);
        signers.set(signer2.clone(), 1u32);

        env.budget().reset_default();
        client.init(&signers, &1u32);
        let (cpu, mem) = measure!(env);

        BenchmarkResult::new(
            "smart_account::init",
            cpu,
            mem,
            cpu_budget::SMART_ACCOUNT_INIT,
            mem_budget::SMART_ACCOUNT_INIT,
        )
    }

    pub fn bench_transfer() -> BenchmarkResult {
        let (env, contract_id, owner, _signer2) = setup_env();
        let client = SmartAccountClient::new(&env, &contract_id);

        let mut signers = Map::new(&env);
        signers.set(owner.clone(), 1u32);

        client.init(&signers, &1u32);

        // Mint tokens into the smart-account contract
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin.clone())
            .address();
        token::StellarAssetClient::new(&env, &token_id).mint(&contract_id, &1000i128);

        let recipient = Address::generate(&env);
        let mut approvers = soroban_sdk::Vec::new(&env);
        approvers.push_back(owner.clone());

        env.budget().reset_default();
        client.transfer(&approvers, &token_id, &recipient, &100i128);
        let (cpu, mem) = measure!(env);

        BenchmarkResult::new(
            "smart_account::transfer",
            cpu,
            mem,
            cpu_budget::SMART_ACCOUNT_TRANSFER,
            mem_budget::SMART_ACCOUNT_TRANSFER,
        )
    }

    pub fn bench_query() -> BenchmarkResult {
        let (env, contract_id, owner, _signer2) = setup_env();
        let client = SmartAccountClient::new(&env, &contract_id);

        let mut signers = Map::new(&env);
        signers.set(owner.clone(), 1u32);
        client.init(&signers, &1u32);

        env.budget().reset_default();
        let _ = client.signers();
        let _ = client.threshold();
        let (cpu, mem) = measure!(env);

        BenchmarkResult::new(
            "smart_account::query (signers+threshold)",
            cpu,
            mem,
            cpu_budget::SMART_ACCOUNT_QUERY,
            mem_budget::SMART_ACCOUNT_QUERY,
        )
    }
}

// ── Paymaster benchmarks ─────────────────────────────────────────────────────

mod bench_paymaster {
    use super::*;
    use paymaster::{Paymaster, PaymasterClient};
    use soroban_sdk::{
        testutils::Address as _,
        token, Address, Env, Symbol,
    };

    fn setup_env() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        env.budget().reset_unlimited();

        let contract_id = env.register(Paymaster, ());
        let owner = Address::generate(&env);
        (env, contract_id, owner)
    }

    pub fn bench_initialize() -> BenchmarkResult {
        let (env, contract_id, owner) = setup_env();
        let client = PaymasterClient::new(&env, &contract_id);

        env.budget().reset_default();
        client.initialize(&owner, &100u32);
        let (cpu, mem) = measure!(env);

        BenchmarkResult::new(
            "paymaster::initialize",
            cpu,
            mem,
            cpu_budget::PAYMASTER_INITIALIZE,
            mem_budget::PAYMASTER_INITIALIZE,
        )
    }

    pub fn bench_deposit() -> BenchmarkResult {
        let (env, contract_id, owner) = setup_env();
        let client = PaymasterClient::new(&env, &contract_id);
        client.initialize(&owner, &100u32);

        let sponsor = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin.clone())
            .address();
        token::StellarAssetClient::new(&env, &token_id).mint(&sponsor, &10_000i128);

        env.budget().reset_default();
        client.deposit(&sponsor, &token_id, &1_000i128);
        let (cpu, mem) = measure!(env);

        BenchmarkResult::new(
            "paymaster::deposit",
            cpu,
            mem,
            cpu_budget::PAYMASTER_DEPOSIT,
            mem_budget::PAYMASTER_DEPOSIT,
        )
    }

    pub fn bench_set_spend_limit() -> BenchmarkResult {
        let (env, contract_id, owner) = setup_env();
        let client = PaymasterClient::new(&env, &contract_id);
        client.initialize(&owner, &100u32);

        let user = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        env.budget().reset_default();
        client.set_spend_limit(&user, &token_id, &5_000i128);
        let (cpu, mem) = measure!(env);

        BenchmarkResult::new(
            "paymaster::set_spend_limit",
            cpu,
            mem,
            cpu_budget::PAYMASTER_SET_SPEND_LIMIT,
            mem_budget::PAYMASTER_SET_SPEND_LIMIT,
        )
    }

    pub fn bench_sponsor_invocation() -> BenchmarkResult {
        let (env, contract_id, owner) = setup_env();
        let client = PaymasterClient::new(&env, &contract_id);
        client.initialize(&owner, &100u32);

        let sponsor = Address::generate(&env);
        let user = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin.clone())
            .address();

        token::StellarAssetClient::new(&env, &token_id).mint(&sponsor, &10_000i128);
        client.deposit(&sponsor, &token_id, &5_000i128);
        client.set_spend_limit(&user, &token_id, &5_000i128);

        let dummy_contract = Address::generate(&env);
        let fn_name = Symbol::new(&env, "transfer");

        env.budget().reset_default();
        client.sponsor_invocation(&sponsor, &user, &dummy_contract, &fn_name, &token_id, &100i128);
        let (cpu, mem) = measure!(env);

        BenchmarkResult::new(
            "paymaster::sponsor_invocation",
            cpu,
            mem,
            cpu_budget::PAYMASTER_SPONSOR,
            mem_budget::PAYMASTER_SPONSOR,
        )
    }
}

// ── SessionKeys benchmarks ───────────────────────────────────────────────────

mod bench_session_keys {
    use super::*;
    use session_keys::{SessionKeysContract, SessionKeysContractClient};
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Address, Env, Symbol, Vec,
    };

    fn setup_env() -> (Env, Address) {
        let env = Env::default();
        env.mock_all_auths();
        env.budget().reset_unlimited();
        env.ledger().set_timestamp(1_000_000);

        let contract_id = env.register(SessionKeysContract, ());
        (env, contract_id)
    }

    fn single_addr(env: &Env, a: &Address) -> Vec<Address> {
        let mut v = Vec::new(env);
        v.push_back(a.clone());
        v
    }

    fn single_sym(env: &Env, s: &str) -> Vec<Symbol> {
        let mut v = Vec::new(env);
        v.push_back(Symbol::new(env, s));
        v
    }

    pub fn bench_register() -> BenchmarkResult {
        let (env, contract_id) = setup_env();
        let client = SessionKeysContractClient::new(&env, &contract_id);

        let owner = Address::generate(&env);
        let session_key = Address::generate(&env);
        let target = Address::generate(&env);

        env.budget().reset_default();
        client.register_session_key(
            &owner,
            &session_key,
            &2_000_000u64,
            &single_addr(&env, &target),
            &single_sym(&env, "transfer"),
            &1000i128,
        );
        let (cpu, mem) = measure!(env);

        BenchmarkResult::new(
            "session_keys::register",
            cpu,
            mem,
            cpu_budget::SESSION_REGISTER,
            mem_budget::SESSION_REGISTER,
        )
    }

    pub fn bench_validate() -> BenchmarkResult {
        let (env, contract_id) = setup_env();
        let client = SessionKeysContractClient::new(&env, &contract_id);

        let owner = Address::generate(&env);
        let session_key = Address::generate(&env);
        let target = Address::generate(&env);
        let method = Symbol::new(&env, "transfer");

        client.register_session_key(
            &owner,
            &session_key,
            &2_000_000u64,
            &single_addr(&env, &target),
            &single_sym(&env, "transfer"),
            &1000i128,
        );

        env.budget().reset_default();
        let _ = client.validate_session_call(&session_key, &target, &method, &100i128);
        let (cpu, mem) = measure!(env);

        BenchmarkResult::new(
            "session_keys::validate",
            cpu,
            mem,
            cpu_budget::SESSION_VALIDATE,
            mem_budget::SESSION_VALIDATE,
        )
    }

    pub fn bench_revoke() -> BenchmarkResult {
        let (env, contract_id) = setup_env();
        let client = SessionKeysContractClient::new(&env, &contract_id);

        let owner = Address::generate(&env);
        let session_key = Address::generate(&env);
        let target = Address::generate(&env);

        client.register_session_key(
            &owner,
            &session_key,
            &2_000_000u64,
            &single_addr(&env, &target),
            &single_sym(&env, "transfer"),
            &1000i128,
        );

        env.budget().reset_default();
        client.revoke_session_key(&owner, &session_key);
        let (cpu, mem) = measure!(env);

        BenchmarkResult::new(
            "session_keys::revoke",
            cpu,
            mem,
            cpu_budget::SESSION_REVOKE,
            mem_budget::SESSION_REVOKE,
        )
    }
}

// ── Entry point ──────────────────────────────────────────────────────────────

fn main() {
    println!("╔══════════════════════════════════════════════════════════════════╗");
    println!("║    Lumena · Soroban Resource Footprint Benchmark Suite           ║");
    println!("╚══════════════════════════════════════════════════════════════════╝");
    println!();
    println!("Running benchmarks…");
    println!();

    let results: Vec<BenchmarkResult> = vec![
        // SmartAccount
        bench_smart_account::bench_init(),
        bench_smart_account::bench_transfer(),
        bench_smart_account::bench_query(),
        // Paymaster
        bench_paymaster::bench_initialize(),
        bench_paymaster::bench_deposit(),
        bench_paymaster::bench_set_spend_limit(),
        bench_paymaster::bench_sponsor_invocation(),
        // SessionKeys
        bench_session_keys::bench_register(),
        bench_session_keys::bench_validate(),
        bench_session_keys::bench_revoke(),
    ];

    let mut report = BenchmarkReport::new(results);

    // Stamp with Unix timestamp (no chrono dependency needed)
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    report.timestamp = ts.to_string();

    // Print table
    report.print_table();

    // Write JSON for the web viewer
    // Written to the crate directory so the viewer (contracts/benchmarks/viewer/)
    // can find it at ../benchmark-results.json
    let json = serde_json::to_string_pretty(&report)
        .expect("failed to serialize benchmark report");

    // Prefer writing next to the manifest (contracts/benchmarks/) so the web
    // viewer can always resolve it; fall back to the current working directory.
    let manifest_dir = option_env!("CARGO_MANIFEST_DIR").unwrap_or(".");
    let out_path = std::path::Path::new(manifest_dir).join("benchmark-results.json");
    fs::write(&out_path, &json).expect("failed to write benchmark-results.json");
    println!("Results written to {}", out_path.display());
    println!();

    // CI: exit non-zero if any benchmark exceeded its budget
    if !report.all_pass {
        eprintln!("ERROR: One or more benchmarks exceeded resource budgets. See table above.");
        process::exit(1);
    }

    println!("All benchmarks passed. Exiting 0.");
}

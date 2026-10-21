#![cfg(test)]

use soroban_sdk::{testutils::Address as _, Address, Env, Vec};

use crate::{Error, SocialRecoveryContract, SocialRecoveryContractClient};

fn setup_env() -> (Env, SocialRecoveryContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(SocialRecoveryContract, ());
    let client = SocialRecoveryContractClient::new(&env, &contract_id);
    (env, client, contract_id)
}

#[test]
fn test_register_and_get_config() {
    let (env, client, _) = setup_env();
    let owner = Address::generate(&env);
    let g1 = Address::generate(&env);
    let g2 = Address::generate(&env);
    let owner_key = Address::generate(&env);

    let mut guardians = Vec::new(&env);
    guardians.push_back(g1.clone());
    guardians.push_back(g2.clone());

    client.register_guardians(&owner, &guardians, &2, &86400, &owner_key);

    let config = client.get_config(&owner);
    assert_eq!(config.threshold, 2);
    assert_eq!(config.timelock_seconds, 86400);
    assert_eq!(config.current_owner_key, owner_key);
    assert_eq!(config.guardians.len(), 2);
}

#[test]
fn test_execute_recovery_updates_config() {
    let (env, client, _) = setup_env();
    let owner = Address::generate(&env);
    let g1 = Address::generate(&env);
    let g2 = Address::generate(&env);
    let old_key = Address::generate(&env);
    let new_key = Address::generate(&env);

    let mut guardians = Vec::new(&env);
    guardians.push_back(g1.clone());
    guardians.push_back(g2.clone());

    client.register_guardians(&owner, &guardians, &2, &0, &old_key);

    client.initiate_recovery(&owner, &g1, &new_key);
    client.vote_recovery(&owner, &g2);

    let returned_key = client.execute_recovery(&owner);
    assert_eq!(returned_key, new_key);

    let config = client.get_config(&owner);
    assert_eq!(config.current_owner_key, new_key);
}

#[test]
fn test_execute_recovery_marks_proposal_executed() {
    let (env, client, _) = setup_env();
    let owner = Address::generate(&env);
    let g1 = Address::generate(&env);
    let old_key = Address::generate(&env);
    let new_key = Address::generate(&env);

    let mut guardians = Vec::new(&env);
    guardians.push_back(g1.clone());

    client.register_guardians(&owner, &guardians, &1, &0, &old_key);
    client.initiate_recovery(&owner, &g1, &new_key);
    client.execute_recovery(&owner);

    let proposal = client.get_proposal(&owner);
    assert!(proposal.executed);
}

#[test]
fn test_double_execute_fails() {
    let (env, client, _) = setup_env();
    let owner = Address::generate(&env);
    let g1 = Address::generate(&env);
    let old_key = Address::generate(&env);
    let new_key = Address::generate(&env);

    let mut guardians = Vec::new(&env);
    guardians.push_back(g1.clone());

    client.register_guardians(&owner, &guardians, &1, &0, &old_key);
    client.initiate_recovery(&owner, &g1, &new_key);
    client.execute_recovery(&owner);

    let result = client.try_execute_recovery(&owner);
    assert_eq!(result, Err(Ok(Error::AlreadyExecuted)));
}

#[test]
fn test_threshold_not_met() {
    let (env, client, _) = setup_env();
    let owner = Address::generate(&env);
    let g1 = Address::generate(&env);
    let g2 = Address::generate(&env);
    let old_key = Address::generate(&env);
    let new_key = Address::generate(&env);

    let mut guardians = Vec::new(&env);
    guardians.push_back(g1.clone());
    guardians.push_back(g2.clone());

    client.register_guardians(&owner, &guardians, &2, &0, &old_key);
    client.initiate_recovery(&owner, &g1, &new_key);

    let result = client.try_execute_recovery(&owner);
    assert_eq!(result, Err(Ok(Error::ThresholdNotMet)));
}

#[test]
fn test_cancel_recovery() {
    let (env, client, _) = setup_env();
    let owner = Address::generate(&env);
    let g1 = Address::generate(&env);
    let old_key = Address::generate(&env);
    let new_key = Address::generate(&env);

    let mut guardians = Vec::new(&env);
    guardians.push_back(g1.clone());

    client.register_guardians(&owner, &guardians, &1, &0, &old_key);
    client.initiate_recovery(&owner, &g1, &new_key);
    client.cancel_recovery(&owner);

    let proposal = client.get_proposal(&owner);
    assert!(proposal.executed);

    let config = client.get_config(&owner);
    assert_eq!(config.current_owner_key, old_key);
}

#[test]
fn test_duplicate_vote_fails() {
    let (env, client, _) = setup_env();
    let owner = Address::generate(&env);
    let g1 = Address::generate(&env);
    let old_key = Address::generate(&env);
    let new_key = Address::generate(&env);

    let mut guardians = Vec::new(&env);
    guardians.push_back(g1.clone());

    client.register_guardians(&owner, &guardians, &1, &0, &old_key);
    client.initiate_recovery(&owner, &g1, &new_key);

    let result = client.try_vote_recovery(&owner, &g1);
    assert_eq!(result, Err(Ok(Error::AlreadyVoted)));
}

#[test]
fn test_same_key_rejected() {
    let (env, client, _) = setup_env();
    let owner = Address::generate(&env);
    let g1 = Address::generate(&env);
    let owner_key = Address::generate(&env);

    let mut guardians = Vec::new(&env);
    guardians.push_back(g1.clone());

    client.register_guardians(&owner, &guardians, &1, &0, &owner_key);

    let result = client.try_initiate_recovery(&owner, &g1, &owner_key);
    assert_eq!(result, Err(Ok(Error::SameKey)));
}

//! Kotha — Speak. Verify. Execute.
//!
//! Prohori Firewall enforces spending limits. Kotha Voice Enclave attests each
//! action. Shakkhi On-Chain Vault stores the receipt.

use near_sdk::store::IterableMap;
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

/// Actions Kotha Voice Enclave may attest and commit to Shakkhi On-Chain Vault.
const ACTION_TYPES: [&str; 5] = ["swap", "transfer", "withdraw", "shield", "unshield"];

/// Nanoseconds in one UTC day. `env::block_timestamp()` is nanoseconds.
const DAY_NS: u64 = 86_400_000_000_000;

/// Default Prohori Firewall policy: $100.00 per day and $50.00 per transaction.
const DEFAULT_DAILY_LIMIT_USD_CENTS: u64 = 10_000;
const DEFAULT_PER_TX_LIMIT_USD_CENTS: u64 = 5_000;

/// One TEE-attested agent action, stored by `correlation_id`.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedExecution {
    pub correlation_id: String,
    pub agent_id: String,
    /// One of "swap", "transfer", "withdraw", "shield", "unshield".
    pub action_type: String,
    pub origin_asset: String,
    pub destination_asset: String,
    pub amount_atomic: String,
    /// Notional size in US cents. `1500` means $15.00.
    pub usd_amount_cents: u64,
    pub near_ai_chat_id: String,
    pub tee_signing_address: String,
    pub request_sha256: String,
    pub response_sha256: String,
    pub tee_signature: String,
    pub timestamp_ns: u64,
}

/// Shakkhi On-Chain Vault. Prohori Firewall rules are enforced here, not only in the UI.
#[derive(PanicOnDefault)]
#[near(contract_state)]
pub struct Contract {
    owner: AccountId,
    agent_account: AccountId,
    paused: bool,
    executions: IterableMap<String, VerifiedExecution>,
    /// Insertion order. Newest records are at the end so `list_executions`
    /// can page in reverse chronological order.
    execution_keys: Vec<String>,
    daily_limit_usd_cents: u64,
    per_tx_limit_usd_cents: u64,
    spent_today_usd_cents: u64,
    current_day_index: u64,
    trusted_tee_signer: Option<String>,
}

#[near]
impl Contract {
    #[init]
    pub fn init(owner: AccountId, agent_account: AccountId) -> Self {
        Self {
            owner,
            agent_account,
            paused: false,
            executions: IterableMap::new(b"e"),
            execution_keys: Vec::new(),
            daily_limit_usd_cents: DEFAULT_DAILY_LIMIT_USD_CENTS,
            per_tx_limit_usd_cents: DEFAULT_PER_TX_LIMIT_USD_CENTS,
            spent_today_usd_cents: 0,
            current_day_index: env::block_timestamp() / DAY_NS,
            trusted_tee_signer: None,
        }
    }

    /// Persist a verified execution.
    ///
    /// Caller must be the owner or the agent. The vault must not be paused.
    /// Cryptographic fields, the trusted TEE signer, per-transaction cap,
    /// daily budget, and correlation-id replay are all checked on chain.
    /// A repeated `correlation_id` is rejected.
    pub fn record_execution(&mut self, execution: VerifiedExecution) {
        require!(!self.paused, "PROHORI_LOCKED: Vault is paused by owner");
        let caller = env::predecessor_account_id();
        require!(
            caller == self.owner || caller == self.agent_account,
            "PROHORI_UNAUTHORIZED"
        );
        require!(
            ACTION_TYPES.contains(&execution.action_type.as_str()),
            "SHAKKHI_INVALID_ACTION"
        );
        require!(
            !execution.correlation_id.is_empty(),
            "SHAKKHI_CORRELATION_REQUIRED"
        );
        require!(
            !execution.request_sha256.is_empty() && execution.request_sha256.len() == 64,
            "SHAKKHI_INVALID_REQ_HASH"
        );
        require!(
            !execution.response_sha256.is_empty() && execution.response_sha256.len() == 64,
            "SHAKKHI_INVALID_RES_HASH"
        );
        require!(
            !execution.tee_signature.is_empty() && execution.tee_signature.len() >= 64,
            "SHAKKHI_INVALID_TEE_SIGNATURE"
        );
        if let Some(signer) = &self.trusted_tee_signer {
            require!(
                execution.tee_signing_address == *signer,
                "SHAKKHI_TRUSTED_SIGNER_MISMATCH"
            );
        }

        let day_index = env::block_timestamp() / DAY_NS;
        if day_index > self.current_day_index {
            self.spent_today_usd_cents = 0;
            self.current_day_index = day_index;
        }

        require!(
            execution.usd_amount_cents <= self.per_tx_limit_usd_cents,
            "PROHORI_PER_TX_LIMIT_EXCEEDED"
        );
        let next_spent = self
            .spent_today_usd_cents
            .checked_add(execution.usd_amount_cents);
        require!(
            next_spent.is_some_and(|spent| spent <= self.daily_limit_usd_cents),
            "PROHORI_DAILY_BUDGET_EXCEEDED"
        );
        require!(
            !self.executions.contains_key(&execution.correlation_id),
            "SHAKKHI_DUPLICATE_CORRELATION_ID"
        );

        self.spent_today_usd_cents = next_spent.expect("checked above");
        let key = execution.correlation_id.clone();
        self.executions.insert(key.clone(), execution);
        self.execution_keys.push(key);
    }

    /// Emergency freeze. Only the owner may pause or unpause the vault.
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
    }

    /// Rotate the account allowed to record executions alongside the owner.
    pub fn update_agent_account(&mut self, agent_account: AccountId) {
        self.assert_owner();
        self.agent_account = agent_account;
    }

    /// Replace the Prohori daily budget and per-transaction cap. Amounts are US cents.
    pub fn update_spending_limits(&mut self, daily_limit_usd_cents: u64, per_tx_limit_usd_cents: u64) {
        self.assert_owner();
        self.daily_limit_usd_cents = daily_limit_usd_cents;
        self.per_tx_limit_usd_cents = per_tx_limit_usd_cents;
    }

    /// Pin the TEE signing address that future executions must match.
    /// `None` clears the pin and accepts any non-empty signature address.
    pub fn set_trusted_tee_signer(&mut self, signer: Option<String>) {
        self.assert_owner();
        self.trusted_tee_signer = signer;
    }

    pub fn get_execution(&self, correlation_id: String) -> Option<VerifiedExecution> {
        self.executions.get(&correlation_id).cloned()
    }

    /// Page executions newest-first.
    ///
    /// `from_index` is the offset from the newest record. `limit` is the
    /// maximum number of records to return.
    pub fn list_executions(&self, from_index: usize, limit: usize) -> Vec<VerifiedExecution> {
        if limit == 0 || from_index >= self.execution_keys.len() {
            return Vec::new();
        }
        self.execution_keys
            .iter()
            .rev()
            .skip(from_index)
            .take(limit)
            .filter_map(|key| self.executions.get(key).cloned())
            .collect()
    }

    /// `(owner, agent_account, paused, total_executions)`.
    pub fn get_vault_info(&self) -> (AccountId, AccountId, bool, u32) {
        (
            self.owner.clone(),
            self.agent_account.clone(),
            self.paused,
            self.execution_keys.len() as u32,
        )
    }

    /// `(daily_limit_usd_cents, per_tx_limit_usd_cents, spent_today_usd_cents, paused)`.
    pub fn get_policy_status(&self) -> (u64, u64, u64, bool) {
        (
            self.daily_limit_usd_cents,
            self.per_tx_limit_usd_cents,
            self.spent_today_usd_cents,
            self.paused,
        )
    }
}

impl Contract {
    fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            "Unauthorized: caller is not the owner"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn switch_caller(predecessor: AccountId, block_timestamp: u64) {
        let mut ctx = VMContextBuilder::new();
        ctx.current_account_id(accounts(0))
            .signer_account_id(predecessor.clone())
            .predecessor_account_id(predecessor)
            .block_timestamp(block_timestamp);
        testing_env!(ctx.build());
    }

    fn init_vault() -> Contract {
        switch_caller(accounts(0), 0);
        Contract::init(accounts(0), accounts(1))
    }

    fn execution(
        correlation_id: &str,
        action_type: &str,
        timestamp_ns: u64,
        usd_amount_cents: u64,
    ) -> VerifiedExecution {
        VerifiedExecution {
            correlation_id: correlation_id.to_string(),
            agent_id: "agent-kotha-prime.near".to_string(),
            action_type: action_type.to_string(),
            origin_asset: "nep141:wrap.near".to_string(),
            destination_asset: "nep141:usdt.tether-token.near".to_string(),
            amount_atomic: "1000000000000000000000000".to_string(),
            usd_amount_cents,
            near_ai_chat_id: format!("chat-{correlation_id}"),
            tee_signing_address: "0xtee".to_string(),
            request_sha256: "a".repeat(64),
            response_sha256: "b".repeat(64),
            tee_signature: "c".repeat(128),
            timestamp_ns,
        }
    }

    #[test]
    fn test_init_default_limits() {
        switch_caller(accounts(0), DAY_NS * 2);
        let contract = Contract::init(accounts(0), accounts(1));
        let (owner, agent, paused, total) = contract.get_vault_info();
        assert_eq!(owner, accounts(0));
        assert_eq!(agent, accounts(1));
        assert!(!paused);
        assert_eq!(total, 0);
        let (daily, per_tx, spent, policy_paused) = contract.get_policy_status();
        assert_eq!(daily, 10_000);
        assert_eq!(per_tx, 5_000);
        assert_eq!(spent, 0);
        assert!(!policy_paused);
        assert_eq!(contract.current_day_index, 2);
        assert!(contract.trusted_tee_signer.is_none());
        assert!(contract.get_execution("missing".to_string()).is_none());
        assert!(contract.list_executions(0, 10).is_empty());
    }

    #[test]
    fn test_record_valid_execution_updates_daily_spend() {
        let mut contract = init_vault();
        switch_caller(accounts(1), 0);
        contract.record_execution(execution("ok", "swap", 10, 1_500));
        let (daily, per_tx, spent, paused) = contract.get_policy_status();
        assert_eq!(daily, 10_000);
        assert_eq!(per_tx, 5_000);
        assert_eq!(spent, 1_500);
        assert!(!paused);
        let stored = contract.get_execution("ok".to_string()).expect("stored");
        assert_eq!(stored.usd_amount_cents, 1_500);
        assert_eq!(stored.request_sha256.len(), 64);
        assert_eq!(stored.response_sha256.len(), 64);
        assert!(stored.tee_signature.len() >= 64);
        assert_eq!(contract.get_vault_info().3, 1);
    }

    #[test]
    #[should_panic(expected = "PROHORI_UNAUTHORIZED")]
    fn test_unauthorized_caller_rejected() {
        let mut contract = init_vault();
        switch_caller(accounts(2), 0);
        contract.record_execution(execution("nope", "swap", 1, 100));
    }

    #[test]
    #[should_panic(expected = "PROHORI_LOCKED: Vault is paused by owner")]
    fn test_emergency_pause_blocks_execution() {
        let mut contract = init_vault();
        switch_caller(accounts(0), 0);
        contract.set_paused(true);
        assert!(contract.get_vault_info().2);
        assert!(contract.get_policy_status().3);
        contract.record_execution(execution("frozen", "swap", 1, 100));
    }

    #[test]
    fn test_unpause_restores_execution() {
        let mut contract = init_vault();
        switch_caller(accounts(0), 0);
        contract.set_paused(true);
        assert!(contract.get_policy_status().3);
        contract.set_paused(false);
        assert!(!contract.get_policy_status().3);
        contract.record_execution(execution("after-unpause", "swap", 4, 250));
        assert_eq!(contract.get_vault_info().3, 1);
        assert_eq!(contract.get_policy_status().2, 250);
    }

    #[test]
    #[should_panic(expected = "PROHORI_PER_TX_LIMIT_EXCEEDED")]
    fn test_per_tx_limit_exceeded_panics() {
        let mut contract = init_vault();
        switch_caller(accounts(0), 0);
        contract.record_execution(execution("too-big", "withdraw", 1, 5_001));
    }

    #[test]
    #[should_panic(expected = "PROHORI_DAILY_BUDGET_EXCEEDED")]
    fn test_daily_budget_cumulative_limit_exceeded_panics() {
        let mut contract = init_vault();
        switch_caller(accounts(0), 0);
        contract.record_execution(execution("spend-a", "swap", 1, 4_000));
        contract.record_execution(execution("spend-b", "transfer", 2, 4_000));
        assert_eq!(contract.get_policy_status().2, 8_000);
        contract.record_execution(execution("spend-c", "withdraw", 3, 2_001));
    }

    #[test]
    fn test_daily_budget_resets_on_new_day_timestamp() {
        let mut contract = init_vault();
        switch_caller(accounts(0), 1_000);
        contract.record_execution(execution("day-0", "swap", 1, 4_500));
        assert_eq!(contract.get_policy_status().2, 4_500);
        assert_eq!(contract.current_day_index, 0);
        switch_caller(accounts(0), DAY_NS);
        contract.record_execution(execution("day-1", "swap", 2, 4_500));
        assert_eq!(contract.get_policy_status().2, 4_500);
        assert_eq!(contract.current_day_index, 1);
        assert_eq!(contract.get_vault_info().3, 2);
    }

    #[test]
    #[should_panic(expected = "SHAKKHI_DUPLICATE_CORRELATION_ID")]
    fn test_duplicate_correlation_id_replay_blocked() {
        let mut contract = init_vault();
        switch_caller(accounts(1), 0);
        contract.record_execution(execution("same", "swap", 1, 100));
        assert!(contract.get_execution("same".to_string()).is_some());
        assert_eq!(contract.get_vault_info().3, 1);
        contract.record_execution(execution("same", "swap", 2, 100));
    }

    #[test]
    #[should_panic(expected = "SHAKKHI_INVALID_REQ_HASH")]
    fn test_invalid_sha256_hash_rejected() {
        let mut contract = init_vault();
        switch_caller(accounts(0), 0);
        let mut bad = execution("bad-hash", "swap", 1, 100);
        bad.request_sha256 = "abcd".to_string();
        assert_ne!(bad.request_sha256.len(), 64);
        contract.record_execution(bad);
    }

    #[test]
    #[should_panic(expected = "SHAKKHI_INVALID_TEE_SIGNATURE")]
    fn test_empty_or_short_tee_signature_rejected() {
        let mut contract = init_vault();
        switch_caller(accounts(0), 0);
        let mut bad = execution("bad-sig", "transfer", 1, 100);
        bad.tee_signature = "short".to_string();
        assert!(bad.tee_signature.len() < 64);
        contract.record_execution(bad);
    }

    #[test]
    #[should_panic(expected = "SHAKKHI_TRUSTED_SIGNER_MISMATCH")]
    fn test_trusted_tee_signer_mismatch_rejected() {
        let mut contract = init_vault();
        switch_caller(accounts(0), 0);
        contract.set_trusted_tee_signer(Some("0xtee".to_string()));
        let mut ok = execution("pinned", "swap", 1, 100);
        ok.tee_signing_address = "0xtee".to_string();
        contract.record_execution(ok);
        assert_eq!(contract.get_policy_status().2, 100);
        let mut bad = execution("forged", "swap", 2, 100);
        bad.tee_signing_address = "0xattacker".to_string();
        contract.record_execution(bad);
    }

    #[test]
    #[should_panic(expected = "PROHORI_PER_TX_LIMIT_EXCEEDED")]
    fn test_owner_update_spending_limits() {
        let mut contract = init_vault();
        switch_caller(accounts(0), 0);
        contract.update_spending_limits(3_000, 1_000);
        let (daily, per_tx, spent, paused) = contract.get_policy_status();
        assert_eq!(daily, 3_000);
        assert_eq!(per_tx, 1_000);
        assert_eq!(spent, 0);
        assert!(!paused);
        contract.record_execution(execution("inside", "transfer", 1, 1_000));
        assert_eq!(contract.get_policy_status().2, 1_000);
        contract.record_execution(execution("outside", "transfer", 2, 1_001));
    }

    #[test]
    #[should_panic(expected = "PROHORI_UNAUTHORIZED")]
    fn test_owner_update_agent_account() {
        let mut contract = init_vault();
        switch_caller(accounts(0), 0);
        contract.update_agent_account(accounts(2));
        assert_eq!(contract.get_vault_info().1, accounts(2));
        switch_caller(accounts(2), 0);
        contract.record_execution(execution("by-new-agent", "withdraw", 5, 250));
        assert_eq!(contract.get_policy_status().2, 250);
        assert!(contract.get_execution("by-new-agent".to_string()).is_some());
        switch_caller(accounts(1), 0);
        contract.record_execution(execution("by-old-agent", "swap", 6, 100));
    }

    #[test]
    fn test_list_executions_reverse_chronological_pagination() {
        let mut contract = init_vault();
        switch_caller(accounts(0), 0);
        contract.record_execution(execution("corr-1", "swap", 1, 100));
        contract.record_execution(execution("corr-2", "transfer", 2, 200));
        contract.record_execution(execution("corr-3", "shield", 3, 300));

        let newest_two = contract.list_executions(0, 2);
        assert_eq!(
            newest_two
                .iter()
                .map(|item| item.correlation_id.as_str())
                .collect::<Vec<_>>(),
            vec!["corr-3", "corr-2"]
        );
        assert_eq!(newest_two[0].timestamp_ns, 3);
        assert_eq!(newest_two[0].usd_amount_cents, 300);

        let page_two = contract.list_executions(1, 2);
        assert_eq!(
            page_two
                .iter()
                .map(|item| item.correlation_id.as_str())
                .collect::<Vec<_>>(),
            vec!["corr-2", "corr-1"]
        );
        assert_eq!(contract.list_executions(0, 10).len(), 3);
        assert!(contract.list_executions(3, 1).is_empty());
        assert!(contract.list_executions(0, 0).is_empty());
    }
}

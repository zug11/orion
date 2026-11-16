//! One macOS Keychain record and one serialized native session cache.
//! No secret crosses IPC or enters the vault. Legacy records retire only after
//! the replacement record has been committed and read back successfully.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::sync::{Mutex, MutexGuard, OnceLock};
use zeroize::{Zeroize, Zeroizing};

const ACCOUNT: &str = "orion-credentials-v1";
const MAX_RECORD_BYTES: usize = 8 * 1024 * 1024;
const MAX_VALUE_BYTES: usize = 4 * 1024 * 1024;
const ALLOWED_SLOTS: &[&str] = &[
    "openai-api-key",
    "anthropic-api-key",
    "elevenlabs-api-key",
    "perplexity-api-key",
    "chatgpt-plan-v2",
];
const UNLOCK_ERROR: &str = "Orion could not unlock saved connections. Use Unlock saved connections in Settings to try again.";
const SAVE_ERROR: &str = "Orion could not securely save and verify the connection. Use Unlock saved connections in Settings before retrying.";
const RETIRE_ERROR: &str = "The connection is saved securely, but Orion could not finish removing its older Keychain entries. Use Unlock saved connections in Settings to finish.";

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Slot {
    value: Option<String>,
    #[serde(default)]
    pending_retirement: bool,
}

impl Drop for Slot {
    fn drop(&mut self) {
        if let Some(value) = self.value.as_mut() {
            value.zeroize();
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    slots: BTreeMap<String, Slot>,
}

impl Default for Record {
    fn default() -> Self {
        Self {
            version: 1,
            slots: BTreeMap::new(),
        }
    }
}

#[derive(Default)]
struct Session {
    record: Option<Record>,
    absent: HashSet<String>,
    failure: Option<String>,
}

trait Backend: Send + Sync {
    fn read(&self) -> Result<Option<Zeroizing<String>>, String>;
    fn write(&self, value: &str) -> Result<(), String>;
}

struct Keychain;

/// Direct mutation APIs do not fetch the old password before changing it.
/// Keep the same user-domain Keychain as keyring, and preserve existing ACLs by
/// updating only the value. Never retry an authorization failure as an add.
#[cfg(target_os = "macos")]
mod mutations {
    use core_foundation::data::CFData;
    use security_framework::item::{
        update_item, ItemAddOptions, ItemAddValue, ItemClass, ItemSearchOptions, ItemUpdateOptions,
        ItemUpdateValue, Location,
    };
    use security_framework::os::macos::keychain::{SecKeychain, SecPreferencesDomain};

    // Security.framework's errSecItemNotFound. Treat no other failure as absence.
    const ITEM_NOT_FOUND: i32 = -25300;

    fn query(keychain: &SecKeychain, account: &str) -> ItemSearchOptions {
        let mut query = ItemSearchOptions::new();
        query
            .keychains(std::slice::from_ref(keychain))
            .class(ItemClass::generic_password())
            .service(super::super::KEYCHAIN_SERVICE)
            .account(account);
        // No load_data/load_refs/load_attributes: mutation never reads a secret.
        query
    }

    fn update_or_add(
        update: impl FnOnce() -> Result<(), i32>,
        add: impl FnOnce() -> Result<(), i32>,
    ) -> Result<(), i32> {
        match update() {
            Err(ITEM_NOT_FOUND) => add(),
            result => result,
        }
    }

    pub(super) fn write(account: &str, value: &str) -> Result<(), String> {
        let keychain = SecKeychain::default_for_domain(SecPreferencesDomain::User)
            .map_err(|_| super::SAVE_ERROR.to_string())?;
        let query = query(&keychain, account);
        update_or_add(
            || {
                let mut update = ItemUpdateOptions::new();
                update.set_value(ItemUpdateValue::Data(CFData::from_buffer(value.as_bytes())));
                update_item(&query, &update).map_err(|error| error.code())
            },
            || {
                ItemAddOptions::new(ItemAddValue::Data {
                    class: ItemClass::generic_password(),
                    data: CFData::from_buffer(value.as_bytes()),
                })
                .set_service(super::super::KEYCHAIN_SERVICE)
                .set_account_name(account)
                .set_location(Location::FileKeychain(keychain))
                .add()
                .map_err(|error| error.code())
            },
        )
        .map_err(|_| super::SAVE_ERROR.to_string())
    }

    pub(super) fn delete(account: &str) -> Result<(), String> {
        let keychain = SecKeychain::default_for_domain(SecPreferencesDomain::User)
            .map_err(|_| super::RETIRE_ERROR.to_string())?;
        match query(&keychain, account).delete() {
            Ok(()) => Ok(()),
            Err(error) if error.code() == ITEM_NOT_FOUND => Ok(()),
            Err(_) => Err(super::RETIRE_ERROR.into()),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn native_mutation_adds_only_when_update_reports_missing() {
            let added = std::cell::Cell::new(0);
            for status in [0, ITEM_NOT_FOUND, -128, -25293, -25308] {
                let result = update_or_add(
                    || if status == 0 { Ok(()) } else { Err(status) },
                    || {
                        added.set(added.get() + 1);
                        Ok(())
                    },
                );
                if status == 0 || status == ITEM_NOT_FOUND {
                    assert!(result.is_ok());
                } else {
                    assert_eq!(result, Err(status));
                }
            }
            assert_eq!(added.get(), 1);
        }

        #[test]
        fn native_mutation_propagates_add_failure_without_retrying() {
            assert_eq!(
                update_or_add(|| Err(ITEM_NOT_FOUND), || Err(-25293)),
                Err(-25293)
            );
        }
    }
}

impl Backend for Keychain {
    fn read(&self) -> Result<Option<Zeroizing<String>>, String> {
        let entry = keyring::Entry::new(super::KEYCHAIN_SERVICE, ACCOUNT)
            .map_err(|_| UNLOCK_ERROR.to_string())?;
        match entry.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(UNLOCK_ERROR.into()),
        }
    }

    fn write(&self, value: &str) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            mutations::write(ACCOUNT, value)
        }
        #[cfg(not(target_os = "macos"))]
        {
            keyring::Entry::new(super::KEYCHAIN_SERVICE, ACCOUNT)
                .map_err(|_| SAVE_ERROR.to_string())?
                .set_password(value)
                .map_err(|_| SAVE_ERROR.into())
        }
    }
}

/// Retire only the exact app-owned legacy account, without fetching its secret.
#[cfg(target_os = "macos")]
pub(crate) fn delete_legacy_entry(account: &str) -> Result<(), String> {
    mutations::delete(account)
}

struct CredentialStore<B> {
    backend: B,
    session: Mutex<Session>,
}

impl<B: Backend> CredentialStore<B> {
    fn new(backend: B) -> Self {
        Self {
            backend,
            session: Mutex::new(Session::default()),
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, Session>, String> {
        self.session.lock().map_err(|_| UNLOCK_ERROR.into())
    }

    fn valid_account(account: &str) -> Result<(), String> {
        if ALLOWED_SLOTS.contains(&account) {
            Ok(())
        } else {
            Err("Orion does not recognize this saved connection.".into())
        }
    }

    fn fail<T>(session: &mut Session, message: &str) -> Result<T, String> {
        session.failure = Some(message.into());
        Err(message.into())
    }

    fn load(&self, session: &mut Session) -> Result<(), String> {
        if let Some(error) = &session.failure {
            return Err(error.clone());
        }
        if session.record.is_some() {
            return Ok(());
        }
        let raw = match self.backend.read() {
            Ok(value) => value,
            Err(_) => return Self::fail(session, UNLOCK_ERROR),
        };
        let record = match raw {
            None => Record::default(),
            Some(raw) => {
                if raw.len() > MAX_RECORD_BYTES {
                    return Self::fail(session, UNLOCK_ERROR);
                }
                let record: Record = match serde_json::from_str(&raw) {
                    Ok(record) => record,
                    Err(_) => return Self::fail(session, UNLOCK_ERROR),
                };
                if record.version != 1
                    || record.slots.iter().any(|(key, slot)| {
                        !ALLOWED_SLOTS.contains(&key.as_str())
                            || slot
                                .value
                                .as_ref()
                                .is_some_and(|value| value.len() > MAX_VALUE_BYTES)
                    })
                {
                    return Self::fail(session, UNLOCK_ERROR);
                }
                record
            }
        };
        session.record = Some(record);
        Ok(())
    }

    fn commit(&self, session: &mut Session, record: Record) -> Result<(), String> {
        let encoded =
            Zeroizing::new(serde_json::to_string(&record).map_err(|_| SAVE_ERROR.to_string())?);
        if encoded.len() > MAX_RECORD_BYTES {
            return Err(
                "Too many saved connection details. Remove an unused connection first.".into(),
            );
        }
        // A failed write or readback may have changed persistent state. Drop the
        // old cache and fail closed until the user's explicit retry reloads it.
        if self.backend.write(&encoded).is_err()
            || !matches!(self.backend.read(), Ok(Some(ref actual)) if actual.as_str() == encoded.as_str())
        {
            session.record = None;
            return Self::fail(session, SAVE_ERROR);
        }
        session.record = Some(record);
        Ok(())
    }

    fn retire(
        &self,
        session: &mut Session,
        account: &str,
        cleanup: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let pending = session
            .record
            .as_ref()
            .unwrap()
            .slots
            .get(account)
            .is_some_and(|slot| slot.pending_retirement);
        if !pending {
            return Ok(());
        }
        if cleanup().is_err() {
            return Self::fail(session, RETIRE_ERROR);
        }
        let mut updated = session.record.as_ref().unwrap().clone();
        updated.slots.get_mut(account).unwrap().pending_retirement = false;
        self.commit(session, updated)
    }

    fn read_or_migrate(
        &self,
        account: &str,
        legacy: impl FnOnce() -> Result<Option<Zeroizing<String>>, String>,
        cleanup: impl FnOnce() -> Result<(), String>,
    ) -> Result<Option<Zeroizing<String>>, String> {
        Self::valid_account(account)?;
        let mut session = self.lock()?;
        // Denying a different connection cannot revoke a secret already unlocked
        // in this process. This fast path never touches Keychain or resumes
        // retirement. Failed commits discard the record, so they cannot use it.
        if session.failure.is_some() {
            if let Some(slot) = session
                .record
                .as_ref()
                .and_then(|record| record.slots.get(account))
            {
                if !slot.pending_retirement {
                    return Ok(slot
                        .value
                        .as_ref()
                        .map(|value| Zeroizing::new(value.clone())));
                }
            }
        }
        self.load(&mut session)?;
        if !session.record.as_ref().unwrap().slots.contains_key(account) {
            if session.absent.contains(account) {
                return Ok(None);
            }
            let value = match legacy() {
                Ok(Some(value)) => value,
                Ok(None) => {
                    session.absent.insert(account.into());
                    return Ok(None);
                }
                Err(_) => return Self::fail(&mut session, UNLOCK_ERROR),
            };
            if value.len() > MAX_VALUE_BYTES {
                return Self::fail(&mut session, UNLOCK_ERROR);
            }
            let mut updated = session.record.as_ref().unwrap().clone();
            updated.slots.insert(
                account.into(),
                Slot {
                    value: Some(value.to_string()),
                    pending_retirement: true,
                },
            );
            self.commit(&mut session, updated)?;
        }
        self.retire(&mut session, account, cleanup)?;
        Ok(session
            .record
            .as_ref()
            .unwrap()
            .slots
            .get(account)
            .and_then(|slot| slot.value.as_ref())
            .map(|value| Zeroizing::new(value.clone())))
    }

    fn rearm(session: &mut Session) {
        if session.failure.take().is_some() {
            session.record = None;
            session.absent.clear();
        }
    }

    fn set_locked(
        &self,
        session: &mut Session,
        account: &str,
        value: Zeroizing<String>,
        pending: bool,
    ) -> Result<(), String> {
        Self::valid_account(account)?;
        if value.len() > MAX_VALUE_BYTES {
            return Err("The saved connection is too large.".into());
        }
        self.load(session)?;
        if !pending
            && session
                .record
                .as_ref()
                .unwrap()
                .slots
                .get(account)
                .is_some_and(|slot| slot.pending_retirement)
        {
            return Self::fail(session, RETIRE_ERROR);
        }
        let mut updated = session.record.as_ref().unwrap().clone();
        updated.slots.insert(
            account.into(),
            Slot {
                value: Some(value.to_string()),
                pending_retirement: pending,
            },
        );
        self.commit(session, updated)?;
        session.absent.remove(account);
        Ok(())
    }

    fn set(&self, account: &str, value: Zeroizing<String>) -> Result<(), String> {
        let mut session = self.lock()?;
        self.set_locked(&mut session, account, value, false)
    }

    fn set_and_retire(
        &self,
        account: &str,
        value: Zeroizing<String>,
        cleanup: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let mut session = self.lock()?;
        Self::rearm(&mut session);
        self.set_locked(&mut session, account, value, true)?;
        self.retire(&mut session, account, cleanup)
    }

    fn delete(
        &self,
        account: &str,
        cleanup: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        Self::valid_account(account)?;
        let mut session = self.lock()?;
        Self::rearm(&mut session);
        self.load(&mut session)?;
        let mut updated = session.record.as_ref().unwrap().clone();
        // The durable tombstone takes authority before deleting legacy entries.
        // A failed retirement can never resurrect an older value on restart.
        updated.slots.insert(
            account.into(),
            Slot {
                value: None,
                pending_retirement: true,
            },
        );
        self.commit(&mut session, updated)?;
        self.retire(&mut session, account, cleanup)
    }

    fn retry_access(&self) -> Result<(), String> {
        let mut session = self.lock()?;
        Self::rearm(&mut session);
        Ok(())
    }
}

fn store() -> &'static CredentialStore<Keychain> {
    static STORE: OnceLock<CredentialStore<Keychain>> = OnceLock::new();
    STORE.get_or_init(|| CredentialStore::new(Keychain))
}

pub(crate) fn read_or_migrate(
    account: &str,
    legacy: impl FnOnce() -> Result<Option<Zeroizing<String>>, String>,
    cleanup: impl FnOnce() -> Result<(), String>,
) -> Result<Option<Zeroizing<String>>, String> {
    store().read_or_migrate(account, legacy, cleanup)
}

pub(crate) fn set(account: &str, value: Zeroizing<String>) -> Result<(), String> {
    store().set(account, value)
}

pub(crate) fn set_and_retire(
    account: &str,
    value: Zeroizing<String>,
    cleanup: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    store().set_and_retire(account, value, cleanup)
}

pub(crate) fn delete(
    account: &str,
    cleanup: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    store().delete(account, cleanup)
}

/// An explicit Settings action rearms a denied/failed Keychain operation.
/// A healthy cache stays loaded; refreshing status cannot generate a new prompt.
pub(crate) fn retry_access() -> Result<(), String> {
    store().retry_access()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Barrier};

    #[derive(Default)]
    struct FakeBackend {
        value: Mutex<Option<String>>,
        reads: AtomicUsize,
        writes: AtomicUsize,
        deny_read: AtomicBool,
        deny_write: AtomicBool,
        wrong_readback: AtomicBool,
    }

    impl FakeBackend {
        fn with(slots: &[(&str, Option<&str>, bool)]) -> Arc<Self> {
            let mut record = Record::default();
            for (account, value, pending) in slots {
                record.slots.insert(
                    (*account).into(),
                    Slot {
                        value: value.map(str::to_string),
                        pending_retirement: *pending,
                    },
                );
            }
            Arc::new(Self {
                value: Mutex::new(Some(serde_json::to_string(&record).unwrap())),
                ..Self::default()
            })
        }

        fn record(&self) -> Record {
            serde_json::from_str(self.value.lock().unwrap().as_ref().unwrap()).unwrap()
        }
    }

    impl Backend for Arc<FakeBackend> {
        fn read(&self) -> Result<Option<Zeroizing<String>>, String> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            if self.deny_read.load(Ordering::SeqCst) {
                return Err("synthetic cancelled authorization".into());
            }
            if self.wrong_readback.load(Ordering::SeqCst) && self.writes.load(Ordering::SeqCst) > 0
            {
                return Ok(Some(Zeroizing::new("{}".into())));
            }
            Ok(self
                .value
                .lock()
                .unwrap()
                .as_ref()
                .map(|value| Zeroizing::new(value.clone())))
        }

        fn write(&self, value: &str) -> Result<(), String> {
            self.writes.fetch_add(1, Ordering::SeqCst);
            if self.deny_write.load(Ordering::SeqCst) {
                return Err("synthetic failed write".into());
            }
            *self.value.lock().unwrap() = Some(value.into());
            Ok(())
        }
    }

    fn no_legacy() -> Result<Option<Zeroizing<String>>, String> {
        panic!("a consolidated slot must not read legacy credentials")
    }

    fn no_retirement() -> Result<(), String> {
        panic!("a settled slot must not retire legacy credentials again")
    }

    #[test]
    fn concurrent_workers_share_one_unlock_across_provider_slots() {
        let backend = FakeBackend::with(&[
            ("openai-api-key", Some("fixture-openai"), false),
            ("anthropic-api-key", Some("fixture-anthropic"), false),
        ]);
        let store = Arc::new(CredentialStore::new(backend.clone()));
        let barrier = Arc::new(Barrier::new(12));
        std::thread::scope(|scope| {
            for index in 0..12 {
                let store = store.clone();
                let barrier = barrier.clone();
                scope.spawn(move || {
                    barrier.wait();
                    let account = if index % 2 == 0 {
                        "openai-api-key"
                    } else {
                        "anthropic-api-key"
                    };
                    assert!(store
                        .read_or_migrate(account, no_legacy, no_retirement)
                        .unwrap()
                        .is_some());
                });
            }
        });
        assert_eq!(backend.reads.load(Ordering::SeqCst), 1);
        assert_eq!(backend.writes.load(Ordering::SeqCst), 0);
        store.retry_access().unwrap();
        assert!(store
            .read_or_migrate("openai-api-key", no_legacy, no_retirement)
            .unwrap()
            .is_some());
        assert_eq!(
            backend.reads.load(Ordering::SeqCst),
            1,
            "healthy Settings refresh keeps the cache"
        );
    }

    #[test]
    fn denial_is_shared_until_explicit_retry_and_never_rearmed_by_automatic_refresh() {
        let backend = FakeBackend::with(&[("chatgpt-plan-v2", Some("fixture-plan"), false)]);
        backend.deny_read.store(true, Ordering::SeqCst);
        let store = CredentialStore::new(backend.clone());
        for account in ALLOWED_SLOTS {
            assert!(store
                .read_or_migrate(account, no_legacy, no_retirement)
                .is_err());
        }
        assert_eq!(backend.reads.load(Ordering::SeqCst), 1);
        backend.deny_read.store(false, Ordering::SeqCst);
        assert!(store
            .set(
                "chatgpt-plan-v2",
                Zeroizing::new("refreshed-fixture".into())
            )
            .is_err());
        assert_eq!(backend.reads.load(Ordering::SeqCst), 1);
        assert_eq!(backend.writes.load(Ordering::SeqCst), 0);
        store.retry_access().unwrap();
        assert_eq!(
            store
                .read_or_migrate("chatgpt-plan-v2", no_legacy, no_retirement)
                .unwrap()
                .as_deref()
                .map(String::as_str),
            Some("fixture-plan")
        );
        assert_eq!(backend.reads.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn legacy_denial_stops_other_provider_prompts_and_missing_entries_are_cached() {
        let backend = Arc::new(FakeBackend::default());
        let store = CredentialStore::new(backend.clone());
        assert!(store
            .read_or_migrate(
                "openai-api-key",
                || Err("fixture denied".into()),
                no_retirement
            )
            .is_err());
        assert!(store
            .read_or_migrate("anthropic-api-key", no_legacy, no_retirement)
            .is_err());
        assert_eq!(backend.reads.load(Ordering::SeqCst), 1);
        assert_eq!(backend.writes.load(Ordering::SeqCst), 0);
        store.retry_access().unwrap();
        assert!(store
            .read_or_migrate("openai-api-key", || Ok(None), no_retirement)
            .unwrap()
            .is_none());
        assert!(store
            .read_or_migrate("openai-api-key", no_legacy, no_retirement)
            .unwrap()
            .is_none());
        assert_eq!(backend.reads.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn another_slot_denial_blocks_a_previously_started_automatic_token_refresh() {
        let backend = FakeBackend::with(&[("chatgpt-plan-v2", Some("fixture-plan"), false)]);
        let store = CredentialStore::new(backend.clone());
        store
            .read_or_migrate("chatgpt-plan-v2", no_legacy, no_retirement)
            .unwrap();
        assert!(store
            .read_or_migrate(
                "anthropic-api-key",
                || Err("fixture denied".into()),
                no_retirement
            )
            .is_err());
        let reads = backend.reads.load(Ordering::SeqCst);
        let writes = backend.writes.load(Ordering::SeqCst);
        assert!(store
            .set(
                "chatgpt-plan-v2",
                Zeroizing::new("refreshed-fixture".into())
            )
            .is_err());
        assert_eq!(backend.reads.load(Ordering::SeqCst), reads);
        assert_eq!(backend.writes.load(Ordering::SeqCst), writes);
        store.retry_access().unwrap();
        store
            .set(
                "chatgpt-plan-v2",
                Zeroizing::new("refreshed-fixture".into()),
            )
            .unwrap();
        assert_eq!(
            backend.record().slots["chatgpt-plan-v2"].value.as_deref(),
            Some("refreshed-fixture")
        );
    }

    #[test]
    fn cached_healthy_slot_remains_readable_after_another_slot_denial_without_os_access() {
        let backend = FakeBackend::with(&[("chatgpt-plan-v2", Some("fixture-plan"), false)]);
        let store = CredentialStore::new(backend.clone());
        store
            .read_or_migrate("chatgpt-plan-v2", no_legacy, no_retirement)
            .unwrap();
        assert!(store
            .read_or_migrate(
                "anthropic-api-key",
                || Err("fixture denied".into()),
                no_retirement
            )
            .is_err());
        let reads = backend.reads.load(Ordering::SeqCst);
        let writes = backend.writes.load(Ordering::SeqCst);
        assert_eq!(
            store
                .read_or_migrate("chatgpt-plan-v2", no_legacy, no_retirement)
                .unwrap()
                .as_deref()
                .map(String::as_str),
            Some("fixture-plan")
        );
        assert!(store
            .read_or_migrate("anthropic-api-key", no_legacy, no_retirement)
            .is_err());
        assert!(store
            .read_or_migrate("openai-api-key", no_legacy, no_retirement)
            .is_err());
        assert!(store
            .set(
                "chatgpt-plan-v2",
                Zeroizing::new("refreshed-fixture".into())
            )
            .is_err());
        assert_eq!(backend.reads.load(Ordering::SeqCst), reads);
        assert_eq!(backend.writes.load(Ordering::SeqCst), writes);
    }

    #[test]
    fn failed_commit_discards_the_healthy_cache_exception() {
        let backend = FakeBackend::with(&[("chatgpt-plan-v2", Some("fixture-plan"), false)]);
        let store = CredentialStore::new(backend.clone());
        store
            .read_or_migrate("chatgpt-plan-v2", no_legacy, no_retirement)
            .unwrap();
        backend.deny_write.store(true, Ordering::SeqCst);
        assert!(store
            .set_and_retire(
                "openai-api-key",
                Zeroizing::new("fixture-key".into()),
                no_retirement
            )
            .is_err());
        let reads = backend.reads.load(Ordering::SeqCst);
        assert!(store
            .read_or_migrate("chatgpt-plan-v2", no_legacy, no_retirement)
            .is_err());
        assert_eq!(backend.reads.load(Ordering::SeqCst), reads);
    }

    #[test]
    fn migration_commits_and_verifies_before_retirement_then_reuses_cache() {
        let backend = Arc::new(FakeBackend::default());
        let store = CredentialStore::new(backend.clone());
        let value = store
            .read_or_migrate(
                "elevenlabs-api-key",
                || Ok(Some(Zeroizing::new("fixture-voice".into()))),
                || {
                    assert_eq!(backend.reads.load(Ordering::SeqCst), 2);
                    let persisted = backend.record();
                    let slot = persisted.slots.get("elevenlabs-api-key").unwrap();
                    assert_eq!(slot.value.as_deref(), Some("fixture-voice"));
                    assert!(slot.pending_retirement);
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(value.as_deref().map(String::as_str), Some("fixture-voice"));
        assert!(!backend.record().slots["elevenlabs-api-key"].pending_retirement);
        assert_eq!(backend.reads.load(Ordering::SeqCst), 3);
        assert_eq!(backend.writes.load(Ordering::SeqCst), 2);
        store
            .read_or_migrate("elevenlabs-api-key", no_legacy, no_retirement)
            .unwrap();
        assert_eq!(backend.reads.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn migration_failure_never_retires_legacy_and_latches_failed_readback() {
        for mismatch in [false, true] {
            let backend = Arc::new(FakeBackend::default());
            backend.deny_write.store(!mismatch, Ordering::SeqCst);
            backend.wrong_readback.store(mismatch, Ordering::SeqCst);
            let store = CredentialStore::new(backend.clone());
            assert!(store
                .read_or_migrate(
                    "openai-api-key",
                    || Ok(Some(Zeroizing::new("fixture-old".into()))),
                    no_retirement
                )
                .is_err());
            let read_count = backend.reads.load(Ordering::SeqCst);
            assert!(store
                .read_or_migrate("anthropic-api-key", no_legacy, no_retirement)
                .is_err());
            assert_eq!(backend.reads.load(Ordering::SeqCst), read_count);
            if mismatch {
                assert!(backend.record().slots["openai-api-key"].pending_retirement);
            } else {
                assert!(backend.value.lock().unwrap().is_none());
            }
        }
    }

    #[test]
    fn pending_retirement_survives_restart_without_falling_back_to_old_secrets() {
        let backend = Arc::new(FakeBackend::default());
        let store = CredentialStore::new(backend.clone());
        assert!(store
            .read_or_migrate(
                "chatgpt-plan-v2",
                || Ok(Some(Zeroizing::new("fixture-plan".into()))),
                || Err("fixture cleanup denied".into())
            )
            .is_err());
        assert!(backend.record().slots["chatgpt-plan-v2"].pending_retirement);
        assert!(store
            .read_or_migrate("chatgpt-plan-v2", no_legacy, no_retirement)
            .is_err());
        let restarted = CredentialStore::new(backend.clone());
        assert_eq!(
            restarted
                .read_or_migrate("chatgpt-plan-v2", no_legacy, || Ok(()))
                .unwrap()
                .as_deref()
                .map(String::as_str),
            Some("fixture-plan")
        );
        assert!(!backend.record().slots["chatgpt-plan-v2"].pending_retirement);
    }

    #[test]
    fn deletion_tombstone_prevents_resurrection_even_when_legacy_retirement_fails() {
        let backend = FakeBackend::with(&[
            ("openai-api-key", Some("fixture-openai"), false),
            ("anthropic-api-key", Some("fixture-anthropic"), false),
        ]);
        let store = CredentialStore::new(backend.clone());
        assert!(store
            .delete("openai-api-key", || Err("fixture denied".into()))
            .is_err());
        let persisted = backend.record();
        assert!(persisted.slots["openai-api-key"].value.is_none());
        assert!(persisted.slots["openai-api-key"].pending_retirement);
        assert_eq!(
            persisted.slots["anthropic-api-key"].value.as_deref(),
            Some("fixture-anthropic")
        );
        let restarted = CredentialStore::new(backend.clone());
        assert!(restarted
            .read_or_migrate("openai-api-key", no_legacy, || Ok(()))
            .unwrap()
            .is_none());
        assert!(restarted
            .read_or_migrate("openai-api-key", no_legacy, no_retirement)
            .unwrap()
            .is_none());
    }

    #[test]
    fn concurrent_saves_preserve_other_provider_slots() {
        let backend = Arc::new(FakeBackend::default());
        let store = Arc::new(CredentialStore::new(backend.clone()));
        std::thread::scope(|scope| {
            for account in ALLOWED_SLOTS {
                let store = store.clone();
                scope.spawn(move || {
                    store
                        .set(account, Zeroizing::new(format!("fixture-{account}")))
                        .unwrap()
                });
            }
        });
        let record = backend.record();
        assert_eq!(record.slots.len(), ALLOWED_SLOTS.len());
        for account in ALLOWED_SLOTS {
            assert_eq!(
                record.slots[*account].value.as_deref(),
                Some(format!("fixture-{account}").as_str())
            );
        }
    }

    #[test]
    fn explicit_save_rearms_denial_and_retires_replaced_legacy_value() {
        let backend = Arc::new(FakeBackend::default());
        backend.deny_read.store(true, Ordering::SeqCst);
        let store = CredentialStore::new(backend.clone());
        assert!(store
            .read_or_migrate("openai-api-key", no_legacy, no_retirement)
            .is_err());
        backend.deny_read.store(false, Ordering::SeqCst);
        store
            .set_and_retire(
                "openai-api-key",
                Zeroizing::new("fixture-replacement".into()),
                || Ok(()),
            )
            .unwrap();
        assert_eq!(
            store
                .read_or_migrate("openai-api-key", no_legacy, no_retirement)
                .unwrap()
                .as_deref()
                .map(String::as_str),
            Some("fixture-replacement")
        );
    }

    #[test]
    fn corrupt_or_unknown_records_fail_closed_without_legacy_reads_or_writes() {
        for raw in [
            "not-json",
            "{\"version\":2,\"slots\":{}}",
            "{\"version\":1,\"slots\":{\"arbitrary\":{\"value\":\"fixture\"}}}",
        ] {
            let backend = Arc::new(FakeBackend {
                value: Mutex::new(Some(raw.into())),
                ..FakeBackend::default()
            });
            let store = CredentialStore::new(backend.clone());
            assert!(store
                .read_or_migrate("openai-api-key", no_legacy, no_retirement)
                .is_err());
            assert_eq!(backend.writes.load(Ordering::SeqCst), 0);
        }
    }
}

pub const SERVICE_NAME: &str = "com.benclawbot.zeus.providers";

pub struct OsCredentialStore;

impl OsCredentialStore {
    fn entry(account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE_NAME, account)
            .map_err(|e| format!("open OS credential '{account}': {e}"))
    }
}

pub trait CredentialStore {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

impl CredentialStore for OsCredentialStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        match Self::entry(account)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("read OS credential '{account}': {error}")),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        Self::entry(account)?
            .set_password(secret)
            .map_err(|e| format!("write OS credential '{account}': {e}"))
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("delete OS credential '{account}': {error}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialUpdate {
    pub account: String,
    pub secret: Option<String>,
}

pub fn apply_updates(
    store: &dyn CredentialStore,
    updates: &[CredentialUpdate],
) -> Result<(), String> {
    let originals = updates
        .iter()
        .map(|update| {
            store
                .get(&update.account)
                .map(|secret| (update.account.clone(), secret))
        })
        .collect::<Result<Vec<_>, _>>()?;

    for (index, update) in updates.iter().enumerate() {
        let result = match update.secret.as_deref() {
            Some(secret) => store.set(&update.account, secret),
            None => store.delete(&update.account),
        };
        if let Err(error) = result {
            for (account, secret) in originals[..index].iter().rev() {
                let rollback = match secret.as_deref() {
                    Some(value) => store.set(account, value),
                    None => store.delete(account),
                };
                if let Err(rollback_error) = rollback {
                    return Err(format!(
                        "{error}; rollback for '{account}' also failed: {rollback_error}"
                    ));
                }
            }
            return Err(error);
        }
    }
    Ok(())
}

pub fn migrate_legacy(
    store: &dyn CredentialStore,
    legacy: &[CredentialUpdate],
) -> Result<bool, String> {
    let missing = legacy
        .iter()
        .filter_map(|update| match store.get(&update.account) {
            Ok(Some(_)) => None,
            Ok(None) => Some(Ok(update.clone())),
            Err(error) => Some(Err(error)),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if missing.is_empty() {
        return Ok(false);
    }
    apply_updates(store, &missing)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemoryStore {
        values: RefCell<HashMap<String, String>>,
        fail_after: Cell<Option<usize>>,
        writes: Cell<usize>,
    }

    impl CredentialStore for MemoryStore {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            Ok(self.values.borrow().get(account).cloned())
        }

        fn set(&self, account: &str, secret: &str) -> Result<(), String> {
            let writes = self.writes.get();
            if self.fail_after.get() == Some(writes) {
                self.fail_after.set(None);
                return Err("injected credential failure".into());
            }
            self.writes.set(writes + 1);
            self.values
                .borrow_mut()
                .insert(account.to_string(), secret.to_string());
            Ok(())
        }

        fn delete(&self, account: &str) -> Result<(), String> {
            self.values.borrow_mut().remove(account);
            Ok(())
        }
    }

    #[test]
    fn applies_set_and_clear_updates() {
        let store = MemoryStore::default();
        store
            .values
            .borrow_mut()
            .insert("openai".into(), "old".into());

        apply_updates(
            &store,
            &[
                CredentialUpdate {
                    account: "openai".into(),
                    secret: None,
                },
                CredentialUpdate {
                    account: "anthropic".into(),
                    secret: Some("new".into()),
                },
            ],
        )
        .unwrap();

        assert_eq!(store.get("openai").unwrap(), None);
        assert_eq!(store.get("anthropic").unwrap().as_deref(), Some("new"));
    }

    #[test]
    fn rolls_back_prior_updates_when_a_later_write_fails() {
        let store = MemoryStore::default();
        store
            .values
            .borrow_mut()
            .insert("openai".into(), "old-a".into());
        store
            .values
            .borrow_mut()
            .insert("anthropic".into(), "old-b".into());
        store.fail_after.set(Some(1));

        let result = apply_updates(
            &store,
            &[
                CredentialUpdate {
                    account: "openai".into(),
                    secret: Some("new-a".into()),
                },
                CredentialUpdate {
                    account: "anthropic".into(),
                    secret: Some("new-b".into()),
                },
            ],
        );

        assert!(result.is_err());
        assert_eq!(store.get("openai").unwrap().as_deref(), Some("old-a"));
        assert_eq!(store.get("anthropic").unwrap().as_deref(), Some("old-b"));
    }

    #[test]
    fn migration_preserves_existing_os_credentials() {
        let store = MemoryStore::default();
        store
            .values
            .borrow_mut()
            .insert("openai".into(), "os-value".into());

        migrate_legacy(
            &store,
            &[
                CredentialUpdate {
                    account: "openai".into(),
                    secret: Some("legacy".into()),
                },
                CredentialUpdate {
                    account: "anthropic".into(),
                    secret: Some("migrate-me".into()),
                },
            ],
        )
        .unwrap();

        assert_eq!(store.get("openai").unwrap().as_deref(), Some("os-value"));
        assert_eq!(
            store.get("anthropic").unwrap().as_deref(),
            Some("migrate-me")
        );
    }
}

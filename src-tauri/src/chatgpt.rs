//! Sign in with ChatGPT for local plan usage. No credentials cross IPC.
use super::*;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const ISSUER: &str = "https://auth.openai.com";
const TOKEN: &str = "https://auth.openai.com/api/accounts/oauth/token";
const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";
const PREFIX: &str = "chatgpt:";
static STORE_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static LOGIN_EPOCH: AtomicU64 = AtomicU64::new(0);

#[derive(Default, Serialize, Deserialize)]
struct Store {
    host: String,
    active: Option<String>,
    accounts: Vec<Account>,
    welcomed: bool,
}
#[derive(Clone, Serialize, Deserialize)]
struct Account {
    id: String,
    subject: String,
    email: String,
    #[serde(default)]
    access: String,
    #[serde(default)]
    refresh: String,
    #[serde(default)]
    identity: String,
    #[serde(default)]
    expires: u64,
    #[serde(default)]
    scopes: Vec<String>,
}
impl Drop for Account {
    fn drop(&mut self) {
        self.access.zeroize();
        self.refresh.zeroize();
        self.identity.zeroize();
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    configured: bool,
    active_id: Option<String>,
    accounts: Vec<AccountLabel>,
    first_connection: bool,
}
#[derive(Serialize)]
struct AccountLabel {
    id: String,
    email: String,
    connected: bool,
}
#[derive(Serialize)]
pub struct Model {
    id: String,
    name: String,
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn random() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "Could not prepare secure ChatGPT sign-in.")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
fn authorization_url(
    host: &str,
    previous: Option<&Account>,
    redirect: &str,
    state: &str,
    nonce: &str,
    verifier: &str,
) -> Url {
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut url = Url::parse("https://auth.openai.com/api/accounts/authorize").unwrap();
    {
        let mut q = url.query_pairs_mut();
        q.extend_pairs([
            (
                "client_id",
                previous
                    .map(|a| a.id.as_str())
                    .unwrap_or("dynamic_agent_client"),
            ),
            ("ext_agent_host_id", host),
            ("redirect_uri", redirect),
            ("response_type", "code"),
            (
                "scope",
                "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
            ),
            ("resource", "https://api.openai.com/v1"),
            ("state", state),
            ("nonce", nonce),
            ("code_challenge_method", "S256"),
            ("code_challenge", &challenge),
        ]);
        if let Some(a) = previous {
            if !a.identity.is_empty() {
                q.append_pair("id_token_hint", &a.identity);
            }
        } else {
            q.append_pair("agent_name_hint", "Orion");
        }
    }
    url
}
fn credential_entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, name)
        .map_err(|_| "Could not access ChatGPT credentials in the OS keychain.".into())
}
#[derive(Serialize, Deserialize)]
struct Manifest {
    generation: String,
    parts: usize,
}
fn read_manifest(raw: &str) -> Result<Manifest, String> {
    let value: Manifest =
        serde_json::from_str(raw).map_err(|_| "Saved ChatGPT credentials could not be read.")?;
    if uuid::Uuid::parse_str(&value.generation).is_err() || value.parts == 0 || value.parts > 2048 {
        return Err("Saved ChatGPT credentials are invalid.".into());
    }
    Ok(value)
}
fn chunk_name(manifest: &Manifest, index: usize) -> String {
    format!("chatgpt-plan-{}-{index}", manifest.generation)
}
const MAX_STORE_BYTES: usize = 1800 * 2048 / 4 * 3;
#[cfg(target_os = "macos")]
const CONSOLIDATED_ACCOUNT: &str = "chatgpt-plan-v2";

fn decode_store(raw: &[u8]) -> Result<Store, String> {
    if raw.len() > MAX_STORE_BYTES {
        return Err("Too many saved ChatGPT connections.".into());
    }
    serde_json::from_slice(raw).map_err(|_| "Saved ChatGPT credentials could not be read.".into())
}
#[cfg(any(target_os = "macos", test))]
fn encode_store(store: &Store) -> Result<Zeroizing<String>, String> {
    let raw = Zeroizing::new(
        serde_json::to_string(store).map_err(|_| "Could not encode ChatGPT credentials.")?,
    );
    if raw.len() > MAX_STORE_BYTES {
        return Err("Too many saved ChatGPT connections.".into());
    }
    Ok(raw)
}
fn read_legacy_entry(name: &str) -> Result<Option<Zeroizing<String>>, String> {
    match credential_entry(name)?.get_password() {
        Ok(raw) => Ok(Some(Zeroizing::new(raw))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read ChatGPT credentials from the OS keychain.".into()),
    }
}

/// Legacy generations remain readable on every platform. The caller does not
/// publish a replacement until all parts decode to a complete valid Store.
fn read_legacy_store(
    mut read: impl FnMut(&str) -> Result<Option<Zeroizing<String>>, String>,
) -> Result<Option<(Store, Manifest)>, String> {
    let Some(raw) = read("chatgpt-plan")? else {
        return Ok(None);
    };
    let manifest = read_manifest(&raw)?;
    let mut encoded = Zeroizing::new(String::new());
    for index in 0..manifest.parts {
        let part = read(&chunk_name(&manifest, index))?
            .ok_or("Could not read the complete ChatGPT credential record.")?;
        if part.len() > 1800 {
            return Err("Invalid ChatGPT credential record.".into());
        }
        encoded.push_str(&part);
    }
    let decoded = Zeroizing::new(
        BASE64_STANDARD
            .decode(encoded.as_bytes())
            .map_err(|_| "Saved ChatGPT credentials are invalid.")?,
    );
    Ok(Some((decode_store(&decoded)?, manifest)))
}

#[cfg(target_os = "macos")]
fn retire_legacy_store(captured: Option<Manifest>) -> Result<(), String> {
    // A pending cleanup after restart has no captured manifest. Retain the old
    // root until every chunk is removed so this explicit retry can find them.
    let manifest = match captured {
        Some(manifest) => manifest,
        None => match read_legacy_entry("chatgpt-plan")? {
            Some(raw) => read_manifest(&raw)?,
            None => return Ok(()),
        },
    };
    retire_legacy_parts(&manifest, crate::credential_store::delete_legacy_entry)
}

#[cfg(any(target_os = "macos", test))]
fn retire_legacy_parts(
    manifest: &Manifest,
    mut remove: impl FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
    for index in 0..manifest.parts {
        if remove(&chunk_name(manifest, index)).is_err() {
            // A denial must stop this attempt immediately, not open another
            // Keychain prompt for every remaining part of the old generation.
            return Err("ChatGPT credentials were moved, but the old Keychain entries could not all be removed. Use Unlock saved connections in Settings to finish.".into());
        }
    }
    remove("chatgpt-plan").map_err(|_| "ChatGPT credentials were moved, but the old Keychain registration could not be removed. Use Unlock saved connections in Settings to finish.".into())
}

async fn load() -> Result<Store, String> {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(target_os = "macos")]
        {
            let legacy_manifest = std::cell::RefCell::new(None);
            let raw = crate::credential_store::read_or_migrate(
                CONSOLIDATED_ACCOUNT,
                || match read_legacy_store(read_legacy_entry)? {
                    Some((store, manifest)) => {
                        let raw = encode_store(&store)?;
                        legacy_manifest.replace(Some(manifest));
                        Ok(Some(raw))
                    }
                    None => Ok(None),
                },
                || retire_legacy_store(legacy_manifest.take()),
            )?;
            raw.map(|raw| decode_store(raw.as_bytes()))
                .unwrap_or_else(|| Ok(Store::default()))
        }
        #[cfg(not(target_os = "macos"))]
        {
            read_legacy_store(read_legacy_entry)
                .map(|saved| saved.map(|(store, _)| store).unwrap_or_default())
        }
    })
    .await
    .map_err(|_| "The ChatGPT credential task could not finish.")?
}

#[cfg(target_os = "macos")]
async fn save(store: &Store) -> Result<(), String> {
    let raw = encode_store(store)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::credential_store::set(CONSOLIDATED_ACCOUNT, raw)
    })
    .await
    .map_err(|_| "The ChatGPT credential save could not finish.")?
}

#[cfg(not(target_os = "macos"))]
async fn save(store: &Store) -> Result<(), String> {
    let encoded = Zeroizing::new(
        BASE64_STANDARD.encode(
            Zeroizing::new(
                serde_json::to_vec(store).map_err(|_| "Could not encode ChatGPT credentials.")?,
            )
            .as_slice(),
        ),
    );
    if encoded.len() > 1800 * 2048 {
        return Err("Too many saved ChatGPT connections.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        // Windows Credential Manager limits each credential blob. Small ASCII chunks
        // also make token sets portable without storing secrets in application files.
        let root = credential_entry("chatgpt-plan")?;
        let old = match root.get_password() {
            Ok(raw) => Some(read_manifest(&raw)?),
            Err(keyring::Error::NoEntry) => None,
            Err(_) => return Err("Could not read the ChatGPT credential registration.".into()),
        };
        let manifest = Manifest {
            generation: uuid::Uuid::new_v4().to_string(),
            parts: encoded.len().div_ceil(1800),
        };
        let write: Result<(), String> = (|| {
            for (index, part) in encoded.as_bytes().chunks(1800).enumerate() {
                credential_entry(&chunk_name(&manifest, index))?
                    .set_password(std::str::from_utf8(part).unwrap())
                    .map_err(|_| "Could not save ChatGPT credentials in the OS keychain.")?;
            }
            // Publish the complete new generation only after every chunk is durable.
            root.set_password(&serde_json::to_string(&manifest).unwrap())
                .map_err(|_| "Could not save the ChatGPT credential registration.".to_string())
        })();
        if write.is_err() {
            for index in 0..manifest.parts {
                if let Ok(entry) = credential_entry(&chunk_name(&manifest, index)) {
                    let _ = entry.delete_credential();
                }
            }
        } else if let Some(old) = old {
            for index in 0..old.parts {
                if let Ok(entry) = credential_entry(&chunk_name(&old, index)) {
                    let _ = entry.delete_credential();
                }
            }
        }
        write
    })
    .await
    .map_err(|_| "The ChatGPT credential save could not finish.")?
}
fn connected(a: &Account) -> bool {
    !a.access.is_empty() && a.scopes.iter().any(|s| s == PLAN_SCOPE)
}
fn clear_tokens(account: &mut Account) {
    account.access.zeroize();
    account.refresh.zeroize();
    account.identity.zeroize();
    account.scopes.clear();
    account.expires = 0;
}
fn status(store: &Store, first: bool) -> Status {
    Status {
        configured: store
            .accounts
            .iter()
            .any(|a| Some(&a.id) == store.active.as_ref() && connected(a)),
        active_id: store.active.clone(),
        accounts: store
            .accounts
            .iter()
            .map(|a| AccountLabel {
                id: a.id.clone(),
                email: if a.email.is_empty() {
                    format!("ChatGPT account {}", account_suffix(&a.id))
                } else if store
                    .accounts
                    .iter()
                    .filter(|other| other.email == a.email)
                    .count()
                    > 1
                {
                    format!("{} · {}", a.email, account_suffix(&a.id))
                } else {
                    a.email.clone()
                },
                connected: connected(a),
            })
            .collect(),
        first_connection: first,
    }
}
fn account_suffix(id: &str) -> String {
    id.chars()
        .skip(id.chars().count().saturating_sub(6))
        .collect()
}
#[tauri::command]
pub async fn chatgpt_status() -> Result<Status, String> {
    let _gate = STORE_GATE.lock().await;
    Ok(status(&load().await?, false))
}
#[tauri::command]
pub async fn chatgpt_cancel_sign_in() {
    LOGIN_EPOCH.fetch_add(1, Ordering::SeqCst);
}

async fn while_sign_in_current<T>(
    generation: &AtomicU64,
    epoch: u64,
    work: impl std::future::Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let cancelled = async {
        loop {
            if generation.load(Ordering::SeqCst) != epoch {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    };
    tokio::select! {
        biased;
        _ = cancelled => Err("ChatGPT sign-in was cancelled.".into()),
        result = work => {
            if generation.load(Ordering::SeqCst) != epoch {
                Err("ChatGPT sign-in was cancelled.".into())
            } else {
                result
            }
        }
    }
}

fn callback_has_state(target: &str, expected_state: &str) -> bool {
    if !target.starts_with("/auth/callback?") || target.contains('#') {
        return false;
    }
    let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else {
        return false;
    };
    let mut states = url.query_pairs().filter(|(key, _)| key == "state");
    states
        .next()
        .is_some_and(|(_, value)| value == expected_state)
        && states.next().is_none()
}

fn callback(
    target: &str,
    expected_state: &str,
    previous: Option<&str>,
) -> Result<(String, String), String> {
    if !callback_has_state(target, expected_state) {
        return Err("ChatGPT sign-in state did not match. Try again.".into());
    }
    let url = Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| "Invalid sign-in callback.")?;
    if url.path() != "/auth/callback" {
        return Err("Invalid sign-in callback path.".into());
    }
    let mut values = HashMap::new();
    for (key, value) in url.query_pairs() {
        if values.insert(key.to_string(), value.to_string()).is_some() {
            return Err("Ambiguous sign-in callback.".into());
        }
    }
    if values.get("state").map(String::as_str) != Some(expected_state) {
        return Err("ChatGPT sign-in state did not match. Try again.".into());
    }
    if values.contains_key("error") {
        return Err("ChatGPT sign-in was declined. Continue with ChatGPT to try again.".into());
    }
    let id = values
        .get("client_id")
        .map(String::as_str)
        .or(previous)
        .ok_or("ChatGPT did not return a client registration.")?;
    if !id.starts_with("oaiapp_") || id.len() > 200 || previous.is_some_and(|p| p != id) {
        return Err("ChatGPT returned a different client registration.".into());
    }
    let code = values
        .get("code")
        .filter(|s| !s.is_empty() && s.len() < 4096)
        .ok_or("ChatGPT did not return an authorization code.")?;
    Ok((code.clone(), id.to_string()))
}
async fn bounded_json(mut response: Response, limit: usize) -> Result<Value, String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The provider response was interrupted.")?
    {
        if bytes.len() + chunk.len() > limit {
            return Err("The provider response exceeded its limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "The provider returned invalid data.".into())
}
struct TokenError {
    message: String,
    invalidates_session: bool,
}
fn token_error(status: u16, value: &Value) -> TokenError {
    let code = value["error"]
        .as_str()
        .or_else(|| value.pointer("/error/code").and_then(Value::as_str))
        .unwrap_or_default();
    let invalidates_session = matches!(
        code,
        "invalid_grant"
            | "invalid_refresh_token"
            | "token_expired"
            | "refresh_token_expired"
            | "refresh_token_invalidated"
            | "refresh_token_reused"
    );
    let message = if invalidates_session {
        "ChatGPT authorization expired or was revoked. Continue with ChatGPT again.".into()
    } else if code == "invalid_client" {
        "ChatGPT could not verify Orion's client registration. Your saved connection was kept."
            .into()
    } else {
        format!("ChatGPT sign-in is temporarily unavailable (HTTP {status}). Your saved connection was kept.")
    };
    TokenError {
        message,
        invalidates_session,
    }
}
async fn tokens(client: &Client, form: &[(&str, &str)]) -> Result<Value, TokenError> {
    let response = client
        .post(TOKEN)
        .form(form)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| TokenError {
            message: "Could not reach ChatGPT sign-in. Try again later.".into(),
            invalidates_session: false,
        })?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let value = bounded_json(response, 128 * 1024)
            .await
            .unwrap_or(Value::Null);
        return Err(token_error(status, &value));
    }
    bounded_json(response, 128 * 1024)
        .await
        .map_err(|message| TokenError {
            message,
            invalidates_session: false,
        })
}
fn verify_identity(raw: &str, id: &str, nonce: &str, keys: &JwkSet) -> Result<Value, String> {
    let fail = || "ChatGPT identity could not be verified. Try signing in again.".to_string();
    let header = decode_header(raw).map_err(|_| fail())?;
    if !matches!(header.alg, Algorithm::RS256 | Algorithm::ES256) {
        return Err(fail());
    }
    let key = keys
        .find(header.kid.as_deref().ok_or_else(fail)?)
        .ok_or_else(fail)?;
    let decoding = DecodingKey::from_jwk(key).map_err(|_| fail())?;
    let mut validation = Validation::new(header.alg);
    validation.set_audience(&[id]);
    validation.set_issuer(&[ISSUER]);
    validation.leeway = 5;
    validation.set_required_spec_claims(&["sub", "exp", "iat", "iss", "aud"]);
    let claims = decode::<Value>(raw, &decoding, &validation)
        .map_err(|_| fail())?
        .claims;
    if claims["nonce"].as_str() != Some(nonce) || claims["sub"].as_str().is_none_or(str::is_empty) {
        return Err(fail());
    }
    Ok(claims)
}
fn apply_tokens(account: &mut Account, value: &Value, initial: bool) -> Result<(), String> {
    let access = value["access_token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("ChatGPT did not return an access token.")?;
    let scopes = value["scope"]
        .as_str()
        .map(|s| s.split_whitespace().map(str::to_string).collect::<Vec<_>>())
        .unwrap_or_else(|| {
            if initial {
                vec![]
            } else {
                account.scopes.clone()
            }
        });
    if !scopes.iter().any(|s| s == PLAN_SCOPE) {
        return Err("ChatGPT plan usage was not enabled. Enable it when signing in, or manage access in ChatGPT settings.".into());
    }
    let refresh = value["refresh_token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(if initial { "" } else { &account.refresh })
        .to_string();
    if initial && refresh.is_empty() {
        return Err("ChatGPT did not return a renewable session.".into());
    }
    account.access = access.to_string();
    account.refresh = refresh;
    if initial {
        if let Some(identity) = value["id_token"].as_str() {
            account.identity = identity.to_string();
        }
    }
    account.scopes = scopes;
    account.expires = now() + value["expires_in"].as_u64().unwrap_or(3600).min(86400);
    Ok(())
}
#[tauri::command]
pub async fn chatgpt_sign_in(
    app: AppHandle,
    client: State<'_, OpenAiClient>,
    account_id: Option<String>,
) -> Result<Status, String> {
    let epoch = LOGIN_EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
    let (host, previous) = {
        let _gate = STORE_GATE.lock().await;
        let mut store = load().await?;
        if store.host.is_empty() {
            store.host = format!("urn:uuid:{}", uuid::Uuid::new_v4());
            save(&store).await?;
        }
        let previous = match account_id.as_deref() {
            Some(id) => Some(
                store
                    .accounts
                    .iter()
                    .find(|a| a.id == id)
                    .ok_or("Choose a saved ChatGPT account.")?
                    .clone(),
            ),
            None => None,
        };
        (store.host.clone(), previous)
    };
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| "Could not open the local ChatGPT callback listener.")?;
    let redirect = format!(
        "http://127.0.0.1:{}/auth/callback",
        listener
            .local_addr()
            .map_err(|_| "Could not prepare sign-in callback.")?
            .port()
    );
    let state = random()?;
    let nonce = random()?;
    let verifier = Zeroizing::new(random()?);
    let url = authorization_url(
        &host,
        previous.as_ref(),
        &redirect,
        &state,
        &nonce,
        &verifier,
    );
    if LOGIN_EPOCH.load(Ordering::SeqCst) != epoch {
        return Err("ChatGPT sign-in was cancelled.".into());
    }
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|_| "Could not open the browser for ChatGPT sign-in.")?;
    let work = async {
        loop {
            if LOGIN_EPOCH.load(Ordering::SeqCst) != epoch {
                return Err("ChatGPT sign-in was cancelled.".to_string());
            }
            let accepted =
                tokio::time::timeout(Duration::from_millis(200), listener.accept()).await;
            let Ok(Ok((mut socket, _))) = accepted else {
                continue;
            };
            let mut data = Vec::new();
            let read = async {
                let mut chunk = [0u8; 1024];
                while !data.windows(4).any(|w| w == b"\r\n\r\n") {
                    let n = socket
                        .read(&mut chunk)
                        .await
                        .map_err(|_| "Invalid sign-in callback.")?;
                    if n == 0 || data.len() + n > 16 * 1024 {
                        return Err("Invalid sign-in callback.");
                    }
                    data.extend_from_slice(&chunk[..n]);
                }
                Ok::<_, &str>(())
            };
            if !matches!(
                tokio::time::timeout(Duration::from_secs(2), read).await,
                Ok(Ok(()))
            ) {
                continue;
            }
            let line = String::from_utf8_lossy(&data);
            let mut words = line.lines().next().unwrap_or_default().split_whitespace();
            let method = words.next();
            let target = words.next().unwrap_or_default();
            if method != Some("GET") || !target.starts_with("/auth/callback?") {
                continue;
            }
            let result = callback(target, &state, previous.as_ref().map(|a| a.id.as_str()));
            let message = if result.is_ok() {
                "Return to Orion to finish connecting."
            } else {
                "Sign-in could not be verified. Return to Orion."
            };
            let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}", message.len(), message);
            let _ = socket.write_all(reply.as_bytes()).await;
            // Unrelated local requests cannot consume a legitimate pending attempt.
            if result
                .as_ref()
                .is_err_and(|e| e.contains("state did not match"))
            {
                continue;
            }
            return result;
        }
    };
    let (code, id) = tokio::time::timeout(Duration::from_secs(180), work)
        .await
        .map_err(|_| "ChatGPT sign-in timed out. Try again.")??;
    // Keep a newly issued registration even if the one-time code expires.
    {
        let _gate = STORE_GATE.lock().await;
        let mut store = load().await?;
        if !store.accounts.iter().any(|a| a.id == id) {
            store.accounts.push(Account {
                id: id.clone(),
                subject: String::new(),
                email: String::new(),
                access: String::new(),
                refresh: String::new(),
                identity: String::new(),
                expires: 0,
                scopes: vec![],
            });
            save(&store).await?;
        }
    }
    let value = while_sign_in_current(&LOGIN_EPOCH, epoch, async {
        tokens(
            &client.0,
            &[
                ("grant_type", "authorization_code"),
                ("client_id", &id),
                ("code", &code),
                ("code_verifier", &verifier),
                ("redirect_uri", &redirect),
                ("resource", "https://api.openai.com/v1"),
            ],
        )
        .await
        .map_err(|error| error.message)
    })
    .await?;
    let raw = value["id_token"]
        .as_str()
        .ok_or("ChatGPT did not return a verifiable identity.")?;
    let keys: JwkSet = while_sign_in_current(&LOGIN_EPOCH, epoch, async {
        let response = client
            .0
            .get("https://auth.openai.com/.well-known/jwks.json")
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|_| "Could not verify ChatGPT identity.")?;
        if !response.status().is_success() {
            return Err("Could not verify ChatGPT identity.".into());
        }
        serde_json::from_value(bounded_json(response, 256 * 1024).await?)
            .map_err(|_| "Could not verify ChatGPT identity.".into())
    })
    .await?;
    let claims = verify_identity(raw, &id, &nonce, &keys)?;
    let mut account = previous.unwrap_or(Account {
        id: id.clone(),
        subject: String::new(),
        email: String::new(),
        access: String::new(),
        refresh: String::new(),
        identity: String::new(),
        expires: 0,
        scopes: vec![],
    });
    if !account.subject.is_empty() && claims["sub"].as_str() != Some(&account.subject) {
        return Err(
            "ChatGPT returned a different account. Add it as a separate connection.".into(),
        );
    }
    account.subject = claims["sub"].as_str().unwrap().to_string();
    account.email = claims["email"].as_str().unwrap_or_default().to_string();
    apply_tokens(&mut account, &value, true)?;
    let _gate = STORE_GATE.lock().await;
    if LOGIN_EPOCH.load(Ordering::SeqCst) != epoch {
        return Err("ChatGPT sign-in was cancelled.".into());
    }
    let mut store = load().await?;
    store.accounts.retain(|a| a.id != id);
    store.accounts.push(account);
    store.active = Some(id);
    let first = !store.welcomed;
    store.welcomed = true;
    save(&store).await?;
    let _ = app.emit("chatgpt-connection-changed", ());
    Ok(status(&store, first))
}
#[tauri::command]
pub async fn chatgpt_select_account(app: AppHandle, account_id: String) -> Result<Status, String> {
    LOGIN_EPOCH.fetch_add(1, Ordering::SeqCst);
    let _gate = STORE_GATE.lock().await;
    let mut store = load().await?;
    if !store
        .accounts
        .iter()
        .any(|a| a.id == account_id && connected(a))
    {
        return Err("Sign in to this ChatGPT account first.".into());
    }
    store.active = Some(account_id);
    save(&store).await?;
    let _ = app.emit("chatgpt-connection-changed", ());
    Ok(status(&store, false))
}
#[tauri::command]
pub async fn chatgpt_sign_out(
    app: AppHandle,
    client: State<'_, OpenAiClient>,
) -> Result<String, String> {
    LOGIN_EPOCH.fetch_add(1, Ordering::SeqCst);
    let _gate = STORE_GATE.lock().await;
    let mut store = load().await?;
    let mut revoked = true;
    if let Some(account) = store
        .accounts
        .iter_mut()
        .find(|a| Some(&a.id) == store.active.as_ref())
    {
        if !account.refresh.is_empty() {
            let discovery = client
                .0
                .get("https://auth.openai.com/.well-known/openid-configuration")
                .timeout(Duration::from_secs(15))
                .send()
                .await;
            let endpoint = match discovery {
                Ok(r) if r.status().is_success() => bounded_json(r, 128 * 1024)
                    .await
                    .ok()
                    .and_then(|v| v["revocation_endpoint"].as_str().map(str::to_string)),
                _ => None,
            };
            revoked = false;
            if let Some(endpoint) = endpoint.filter(|s| {
                Url::parse(s)
                    .is_ok_and(|u| u.scheme() == "https" && u.host_str() == Some("auth.openai.com"))
            }) {
                for delay in [0, 400] {
                    if delay > 0 {
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                    }
                    if let Ok(r) = client
                        .0
                        .post(&endpoint)
                        .form(&[
                            ("token", account.refresh.as_str()),
                            ("token_type_hint", "refresh_token"),
                            ("client_id", &account.id),
                        ])
                        .timeout(Duration::from_secs(15))
                        .send()
                        .await
                    {
                        if r.status().is_success() {
                            revoked = true;
                            break;
                        }
                        if !r.status().is_server_error() {
                            break;
                        }
                    }
                }
            }
        }
        clear_tokens(account);
    }
    // Keep the registration and host for the next sign-in.
    save(&store).await?;
    let _ = app.emit("chatgpt-connection-changed", ());
    Ok(if revoked { "Signed out of ChatGPT." } else { "Signed out locally. Remote revocation was not confirmed; disconnect Orion in ChatGPT Settings → Usage." }.into())
}
pub fn is_model(model: &str) -> bool {
    model.starts_with(PREFIX)
}
pub async fn model_key(model: &str) -> Result<Option<Zeroizing<String>>, String> {
    if is_model(model) {
        let client =
            provider_http_client().map_err(|_| "Could not prepare the ChatGPT connection.")?;
        credential(&client).await.map(Some)
    } else {
        stored_api_key().await
    }
}
pub async fn credential(client: &Client) -> Result<Zeroizing<String>, String> {
    credential_for_account(client, None).await
}
pub async fn credential_for_account(
    client: &Client,
    expected: Option<&str>,
) -> Result<Zeroizing<String>, String> {
    let _gate = STORE_GATE.lock().await;
    let mut store = load().await?;
    let account = store
        .accounts
        .iter_mut()
        .find(|a| Some(&a.id) == store.active.as_ref() && connected(a))
        .ok_or("Continue with ChatGPT in Settings before using a ChatGPT plan model.")?;
    if expected.is_some_and(|id| id != account.id) {
        return Err("The ChatGPT account changed. Start the drawing again.".into());
    }
    if account.expires <= now() + 60 {
        let result = tokens(
            client,
            &[
                ("grant_type", "refresh_token"),
                ("client_id", &account.id),
                ("refresh_token", &account.refresh),
                ("resource", "https://api.openai.com/v1"),
            ],
        )
        .await;
        let value = match result {
            Ok(value) => value,
            Err(error) => {
                if error.invalidates_session {
                    clear_tokens(account);
                    save(&store).await?;
                }
                return Err(error.message);
            }
        };
        if let Err(error) = apply_tokens(account, &value, false) {
            if value["scope"]
                .as_str()
                .is_some_and(|scopes| !scopes.split_whitespace().any(|scope| scope == PLAN_SCOPE))
            {
                clear_tokens(account);
                save(&store).await?;
            }
            return Err(error);
        }
        let token = Zeroizing::new(account.access.clone());
        save(&store).await?;
        return Ok(token);
    }
    Ok(Zeroizing::new(account.access.clone()))
}
#[tauri::command]
pub async fn chatgpt_models(client: State<'_, OpenAiClient>) -> Result<Vec<Model>, String> {
    fetch_models(&client.0).await
}
async fn fetch_models(client: &Client) -> Result<Vec<Model>, String> {
    let access = credential(client).await?;
    let response = client
        .get(OPENAI_MODELS_URL)
        .bearer_auth(access.as_str())
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| "Could not load ChatGPT plan models.")?;
    if !response.status().is_success() {
        return Err(error(response).await);
    }
    let value = bounded_json(response, 2 * 1024 * 1024).await?;
    model_catalog(&value)
}
#[tauri::command]
pub async fn illustration_models(
    client: State<'_, OpenAiClient>,
    plan: bool,
    account_id: Option<String>,
) -> Result<Value, String> {
    // Older Space settings may predate chatgptAccountId. Pin the account whose
    // catalog was read so subsequent drawing and review calls cannot drift.
    let account_id = if plan && account_id.is_none() {
        Some(
            chatgpt_status()
                .await?
                .active_id
                .ok_or("Choose a connected ChatGPT account in Settings.")?,
        )
    } else {
        account_id
    };
    let key = if plan {
        credential_for_account(&client.0, account_id.as_deref()).await?
    } else {
        stored_api_key()
            .await?
            .ok_or("Add an OpenAI API key in Settings.")?
    };
    let response = client
        .0
        .get(OPENAI_MODELS_URL)
        .bearer_auth(key.as_str())
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|_| "Could not load the drawing model catalog.")?;
    // A restricted API key can be allowed to create responses without permission
    // to list models. The Responses request itself then determines access.
    if !plan && response.status() == reqwest::StatusCode::FORBIDDEN {
        return Ok(Value::Null);
    }
    if !response.status().is_success() {
        return Err(if plan {
            error(response).await
        } else {
            super::openai_error(response, "list drawing models").await
        });
    }
    let mut items = drawing_model_items(&bounded_json(response, 2 * 1024 * 1024).await?, plan)?;
    if let (true, Some(id), Some(items)) = (plan, account_id, items.as_array_mut()) {
        for item in items {
            item["planAccountId"] = json!(id);
        }
    }
    Ok(items)
}

fn drawing_model_items(catalog: &Value, plan: bool) -> Result<Value, String> {
    let plan_catalog = plan && catalog["models"].is_array();
    let models = catalog[if plan_catalog { "models" } else { "data" }]
        .as_array()
        .ok_or("The connection returned an invalid model catalog.")?;
    let items = models
        .iter()
        .filter_map(|m| {
            if plan_catalog && m["visibility"] != "list" {
                return None;
            }
            let id = m[if plan_catalog { "slug" } else { "id" }].as_str()?;
            if id.len() > 110
                || !id.contains("-astra")
                || !id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || ".-".contains(c))
            {
                return None;
            }
            let mut item = json!({"id": if plan {format!("{PREFIX}{id}")} else {id.to_owned()}});
            if let Some(name) = m["display_name"].as_str() {
                item["name"] = json!(name.chars().take(128).collect::<String>());
            }
            if let Some(levels) = m
                .get("supported_reasoning_levels")
                .or_else(|| m.get("supported_reasoning_efforts"))
                .and_then(Value::as_array)
            {
                item["efforts"] = json!(levels
                    .iter()
                    .filter_map(|v| v.as_str().or_else(|| v["effort"].as_str()))
                    .filter(|s| matches!(*s, "none" | "low" | "medium" | "high" | "xhigh" | "max"))
                    .collect::<Vec<_>>());
            }
            Some(item)
        })
        .collect::<Vec<_>>();
    Ok(json!(items))
}

fn model_catalog(value: &Value) -> Result<Vec<Model>, String> {
    let models = value["models"]
        .as_array()
        .ok_or("ChatGPT did not return an account model catalog.")?;
    Ok(models
        .iter()
        .filter(|m| m["visibility"] == "list")
        .filter_map(|m| {
            let id = m["slug"].as_str()?;
            if id.is_empty()
                || id.len() > 110
                || !id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
            {
                return None;
            }
            Some(Model {
                id: format!("{PREFIX}{id}"),
                name: m["display_name"].as_str().unwrap_or(id).to_string(),
            })
        })
        .take(100)
        .collect())
}
/// Keep the requested response representation coupled to the plan body transform.
/// Plan access requires SSE; API-key Responses requests retain ordinary JSON.
pub fn text_request(request: reqwest::RequestBuilder, mut body: Value) -> reqwest::RequestBuilder {
    let accept = if prepare(&mut body) || body["stream"] == true {
        "text/event-stream"
    } else {
        "application/json"
    };
    request.header(reqwest::header::ACCEPT, accept).json(&body)
}
fn prepare(body: &mut Value) -> bool {
    let Some(model) = body["model"]
        .as_str()
        .and_then(|s| s.strip_prefix(PREFIX))
        .map(str::to_string)
    else {
        return false;
    };
    body["model"] = json!(model);
    body["store"] = json!(false);
    body["stream"] = json!(true);
    if let Some(text) = body["input"].as_str() {
        body["input"] = json!([{ "role": "user", "content": text }]);
    }
    for field in [
        "background",
        "conversation",
        "max_output_tokens",
        "max_tool_calls",
        "metadata",
        "moderation",
        "multi_agent",
        "prompt",
        "prompt_cache_retention",
        "safety_identifier",
        "temperature",
        "top_logprobs",
        "top_p",
        "truncation",
        "user",
        "previous_response_id",
    ] {
        body.as_object_mut().unwrap().remove(field);
    }
    true
}
pub async fn error(response: Response) -> String {
    let status = response.status().as_u16();
    let data = bounded_json(response, 128 * 1024)
        .await
        .unwrap_or(Value::Null);
    plan_error(
        status,
        data.pointer("/error/code")
            .and_then(Value::as_str)
            .or_else(|| data.pointer("/error/type").and_then(Value::as_str))
            .unwrap_or_default(),
    )
}
fn plan_error(status: u16, code: &str) -> String {
    match code {
        "subscription_sharing_usage_limit_exceeded" => "ChatGPT plan usage limit reached. Manage usage in ChatGPT Settings → Usage.",
        "subscription_sharing_usage_unavailable" | "subscription_sharing_user_unavailable" => "ChatGPT plan usage is temporarily unavailable. Try again later.",
        "subscription_sharing_user_not_eligible" => "This ChatGPT account or workspace is not eligible for plan usage. Check ChatGPT Settings → Usage.",
        "subscription_sharing_unsupported_capability" | "subscription_sharing_route_not_supported" => "This request uses a capability unavailable with ChatGPT plan access.",
        "context_length_exceeded" => "This request exceeded the ChatGPT model's context window. Narrow the research question and retry.",
        "rate_limit_exceeded" | "rate_limit_error" => "ChatGPT is limiting requests. Wait a moment before retrying this worker.",
        "insufficient_quota" => "ChatGPT reported a usage limit. Check ChatGPT Settings → Usage before retrying.",
        "server_error" | "service_unavailable" | "overloaded_error" => "ChatGPT reported a temporary service error. Retry when the service is available.",
        "model_not_found" => "The selected ChatGPT model is unavailable for this account. Check the model in Orion Settings.",
        "invalid_request_error" | "invalid_json_schema" => "ChatGPT rejected the request format. Check the selected model and its supported capabilities.",
        _ if status == 401 => "ChatGPT authorization expired or was revoked. Continue with ChatGPT again.",
        _ if status == 429 => "ChatGPT rate or usage limit reached. Manage usage in ChatGPT Settings → Usage.",
        _ if status == 403 => "ChatGPT plan access was denied. Check the account and permissions in ChatGPT Settings → Usage.",
        _ if (500..600).contains(&status) => return format!("ChatGPT returned a service error (HTTP {status}). Retry when the service is available."),
        _ if status > 0 => return format!("ChatGPT declined this request (HTTP {status}). Your saved connection was kept."),
        _ => "ChatGPT reported a failed response without a recognized reason. Your saved connection was kept. You can retry this request.",
    }.to_string()
}
/// Retain finalized output items, but publish nothing until response.completed.
/// SIWC may omit those items from its terminal response envelope.
#[derive(Clone)]
struct FinishedItem {
    index: Option<usize>,
    item: Value,
}
struct Events {
    pending: Vec<u8>,
    total: usize,
    limit: usize,
    finished: Vec<FinishedItem>,
}
impl Default for Events {
    fn default() -> Self {
        Self {
            pending: vec![],
            total: 0,
            limit: 16 * 1024 * 1024,
            finished: vec![],
        }
    }
}
impl Events {
    fn retain_finished(
        items: &mut Vec<FinishedItem>,
        item: Value,
        index: Option<usize>,
    ) -> Result<(), String> {
        let invalid =
            || "ChatGPT returned conflicting or invalid completed stream items.".to_string();
        if !item.is_object()
            || item["type"]
                .as_str()
                .is_none_or(|s| s.is_empty() || s.len() > 100 || s.chars().any(char::is_control))
            || item.get("id").is_some_and(|id| {
                id.as_str().is_none_or(|s| {
                    s.is_empty() || s.len() > 256 || s.chars().any(char::is_control)
                })
            })
            || item
                .get("status")
                .is_some_and(|status| status != "completed")
            || index.is_some_and(|index| index >= 1024)
        {
            return Err(invalid());
        }
        let id = item.get("id").and_then(Value::as_str);
        let mut matched = None;
        for (position, existing) in items.iter().enumerate() {
            let same_id = id.is_some() && existing.item.get("id").and_then(Value::as_str) == id;
            let same_index = index.is_some() && existing.index == index;
            let same_anonymous = id.is_none()
                && existing.item.get("id").is_none()
                && index.is_none()
                && existing.index.is_none()
                && existing.item == item;
            if same_id || same_index || same_anonymous {
                if matched.is_some() {
                    return Err(invalid());
                }
                if existing.item != item
                    || (same_id
                        && existing.index.is_some()
                        && index.is_some()
                        && existing.index != index)
                {
                    return Err(invalid());
                }
                matched = Some(position);
            }
        }
        if let Some(position) = matched {
            if items[position].index.is_none() {
                items[position].index = index;
            }
            return Ok(());
        }
        if items.len() >= 1024 {
            return Err("ChatGPT returned too many completed stream items.".into());
        }
        items.push(FinishedItem { index, item });
        Ok(())
    }

    fn completed_response(&self, mut response: Value) -> Result<Value, String> {
        if self.finished.is_empty() {
            return Ok(response);
        }
        let terminal = match response.get("output") {
            None | Some(Value::Null) => &[][..],
            Some(Value::Array(items)) if items.len() <= 1024 => items.as_slice(),
            _ => return Err("ChatGPT returned invalid completed output.".into()),
        };
        let mut merged = self.finished.clone();
        for (index, item) in terminal.iter().enumerate() {
            // A terminal envelope can contain only a subset and reindex that
            // subset. Provider IDs (or exact id-less items) establish identity
            // before considering its array position.
            let id = item.get("id").and_then(Value::as_str);
            if let Some(existing) = merged.iter().find(|entry| {
                if let Some(id) = id {
                    entry.item.get("id").and_then(Value::as_str) == Some(id)
                } else {
                    entry.item == *item
                }
            }) {
                if existing.item != *item {
                    return Err("ChatGPT returned conflicting terminal stream output.".into());
                }
                continue;
            }
            Self::retain_finished(&mut merged, item.clone(), Some(index))?;
        }
        // Indexed events use protocol order even when they finish out of order.
        // Official SIWC/Codex fixtures also allow id/index-less done items; for
        // those, preserve their deterministic arrival order without guessing IDs.
        if merged.iter().all(|entry| entry.index.is_some()) {
            merged.sort_by_key(|entry| entry.index);
        }
        response["output"] = Value::Array(merged.into_iter().map(|entry| entry.item).collect());
        Ok(response)
    }

    #[cfg(test)]
    fn feed(&mut self, chunk: &[u8]) -> Result<Option<Value>, String> {
        self.feed_with_delta(chunk, &|_| {})
    }

    fn feed_with_delta(
        &mut self,
        chunk: &[u8],
        delta: &dyn Fn(&str),
    ) -> Result<Option<Value>, String> {
        self.total += chunk.len();
        if self.total > self.limit {
            return Err("ChatGPT response exceeded its limit.".into());
        }
        self.pending.extend_from_slice(chunk);
        while let Some(event) = next_stream_event(&mut self.pending)? {
            #[cfg(test)]
            super::openai_web::record_live_stream_structure(&event);
            match event["type"].as_str() {
                Some("response.output_text.delta") => {
                    if let Some(text) = event["delta"].as_str() {
                        delta(text);
                    }
                }
                Some("response.output_item.done") => {
                    let index = match event.get("output_index") {
                        None => None,
                        Some(value) => Some(
                            value
                                .as_u64()
                                .and_then(|value| usize::try_from(value).ok())
                                .ok_or("ChatGPT returned an invalid completed item index.")?,
                        ),
                    };
                    Self::retain_finished(&mut self.finished, event["item"].clone(), index)?;
                }
                Some("response.completed") => {
                    if event["response"]["status"] != "completed" {
                        return Err("ChatGPT returned an incomplete response.".into());
                    }
                    return self.completed_response(event["response"].clone()).map(Some);
                }
                Some("response.failed" | "error") => {
                    return Err(plan_error(
                        0,
                        [
                            "/response/error/code",
                            "/error/code",
                            "/code",
                            "/response/error/type",
                            "/error/type",
                        ]
                        .iter()
                        .find_map(|path| event.pointer(path).and_then(Value::as_str))
                        .unwrap_or_default(),
                    ))
                }
                Some("response.incomplete") => {
                    if event
                        .pointer("/response/incomplete_details/reason")
                        .and_then(Value::as_str)
                        == Some("max_output_tokens")
                    {
                        return Err("ChatGPT reached the output limit before finishing. Retry with a shorter answer or a narrower research question.".into());
                    }
                    return Err(
                        "ChatGPT returned an incomplete response. Try a smaller request.".into(),
                    );
                }
                _ => {}
            }
        }
        Ok(None)
    }
}

fn next_stream_event(pending: &mut Vec<u8>) -> Result<Option<Value>, String> {
    loop {
        let Some((end, size)) = [
            pending
                .windows(2)
                .position(|s| s == b"\n\n")
                .map(|n| (n, 2)),
            pending
                .windows(4)
                .position(|s| s == b"\r\n\r\n")
                .map(|n| (n, 4)),
        ]
        .into_iter()
        .flatten()
        .min_by_key(|(n, _)| *n) else {
            return Ok(None);
        };
        let frame = pending.drain(..end + size).collect::<Vec<_>>();
        let frame = std::str::from_utf8(&frame)
            .map_err(|_| "The provider returned invalid stream text.")?;
        let data = frame
            .lines()
            .filter_map(|l| l.strip_prefix("data:").map(str::trim_start))
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let event: Value = serde_json::from_str(&data)
            .map_err(|_| "The provider returned invalid stream data.")?;
        return Ok(Some(event));
    }
}

pub async fn read_visual_stream(
    mut response: Response,
    anthropic: bool,
    on_delta: &tauri::ipc::Channel<String>,
) -> Result<Value, String> {
    let emit = |text: &str| {
        let _ = on_delta.send(text.to_owned());
    };
    if !anthropic {
        return read_response_deltas(response, 4_000_000, true, &emit).await;
    }
    let mut pending = Vec::new();
    let mut total = 0;
    let mut texts = std::collections::BTreeMap::<u64, String>::new();
    let mut reason = None;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Anthropic's visual stream was interrupted.")?
    {
        total += chunk.len();
        if total > 4_000_000 {
            return Err("The visual stream exceeded its size limit.".into());
        }
        pending.extend_from_slice(&chunk);
        while let Some(event) = next_stream_event(&mut pending)? {
            match event["type"].as_str() {
                Some("content_block_start") if event["content_block"]["type"] == "text" => {
                    let index = event["index"].as_u64().ok_or("Invalid text block index.")?;
                    let initial = event["content_block"]["text"]
                        .as_str()
                        .ok_or("Invalid text block.")?;
                    if texts.len() >= 64 || texts.insert(index, initial.to_string()).is_some() {
                        return Err("Invalid text block.".into());
                    }
                    emit(initial);
                }
                Some("content_block_delta") if event["delta"]["type"] == "text_delta" => {
                    let index = event["index"].as_u64().ok_or("Invalid text block index.")?;
                    let text = event["delta"]["text"]
                        .as_str()
                        .ok_or("Invalid text delta.")?;
                    texts
                        .get_mut(&index)
                        .ok_or("Unknown text block.")?
                        .push_str(text);
                    emit(text);
                }
                Some("message_delta") => {
                    reason = event["delta"]["stop_reason"].as_str().map(str::to_owned)
                }
                Some("message_stop")
                    if matches!(reason.as_deref(), Some("end_turn" | "stop_sequence")) =>
                {
                    let content = texts
                        .into_values()
                        .map(|text| json!({"type":"text","text":text}))
                        .collect::<Vec<_>>();
                    return Ok(json!({"stop_reason":reason,"content":content}));
                }
                Some("message_stop" | "error") => {
                    return Err("Anthropic could not finish the visual.".into())
                }
                _ => {}
            }
        }
    }
    Err("Anthropic's visual stream ended before completion.".into())
}

pub async fn read_for_model(response: Response, model: &str) -> Result<Value, String> {
    let plan = is_model(model);
    read_response(response, 16 * 1024 * 1024, plan)
        .await
        .map_err(|message| {
            if plan {
                message
            } else {
                format!("Orion could not read OpenAI's response: {message}")
            }
        })
}
/// ChatGPT plan requests require an SSE terminal event, including bounded callers.
pub async fn read_with_limit(response: Response, limit: usize) -> Result<Value, String> {
    read_response(response, limit, true).await
}
async fn read_response(
    response: Response,
    limit: usize,
    require_stream: bool,
) -> Result<Value, String> {
    read_response_deltas(response, limit, require_stream, &|_| {}).await
}

async fn read_response_deltas(
    mut response: Response,
    limit: usize,
    require_stream: bool,
    delta: &(dyn Fn(&str) + Sync),
) -> Result<Value, String> {
    // The official SIWC DevKit allows a missing/empty Content-Type on the direct
    // route. Still parse bounded SSE and require response.completed; this is not
    // permission to accept JSON or an unfinished body as a successful plan reply.
    let stream = match response.headers().get(reqwest::header::CONTENT_TYPE) {
        None => require_stream,
        Some(value) => value.to_str().ok().is_some_and(|value| {
            let mime = value.split(';').next().unwrap_or_default().trim();
            mime.eq_ignore_ascii_case("text/event-stream") || (require_stream && mime.is_empty())
        }),
    };
    if !stream {
        if require_stream {
            return Err("ChatGPT did not return a completed response stream. Try again.".into());
        }
        return bounded_json(response, limit).await;
    }
    let mut events = Events {
        limit,
        ..Events::default()
    };
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "ChatGPT stream was interrupted. No complete result was received.")?
    {
        if let Some(value) = events.feed_with_delta(&chunk, delta)? {
            return Ok(value);
        }
    }
    Err("ChatGPT stream ended without a completed response. Try again.".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires an explicitly authorized ChatGPT sign-in and ORION_CHATGPT_LIVE_QA=1"]
    async fn live_connection_catalog_smoke() {
        assert_eq!(
            std::env::var("ORION_CHATGPT_LIVE_QA").as_deref(),
            Ok("1"),
            "Live ChatGPT QA must be explicitly enabled."
        );
        let state = chatgpt_status()
            .await
            .expect("Could not inspect ChatGPT connection status.");
        assert!(
            state.configured,
            "Sign in to ChatGPT in this app identity before running the live check."
        );
        let client = provider_http_client().expect("Could not prepare the provider client.");
        let models = fetch_models(&client)
            .await
            .expect("ChatGPT account catalog request failed.");
        assert!(
            !models.is_empty(),
            "The connected account returned no selectable models."
        );
        let selected = std::env::var("ORION_CHATGPT_LIVE_MODEL").ok();
        let model = selected.as_deref().map_or_else(
            || &models[0],
            |id| {
                models
                    .iter()
                    .find(|model| model.id == id)
                    .expect("Requested smoke model is not in the connected account catalog.")
            },
        );
        let mut body = json!({"model": model.id, "input": "Reply with exactly ORION_CONNECTION_OK and nothing else."});
        if model.id.starts_with("chatgpt:gpt-5") || model.id.starts_with("chatgpt:gpt-6") {
            body["reasoning"] = json!({"effort":"low"});
        }
        let access = credential(&client)
            .await
            .expect("Could not obtain the ChatGPT plan credential.");
        let started = std::time::Instant::now();
        // Exactly one synthetic inference request; never retry or switch billing.
        let response = text_request(
            client
                .post(OPENAI_RESPONSES_URL)
                .bearer_auth(access.as_str()),
            body,
        )
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .expect("ChatGPT smoke inference could not reach the provider.");
        if !response.status().is_success() {
            panic!("ChatGPT smoke inference failed: {}", error(response).await);
        }
        let value = read_for_model(response, &model.id)
            .await
            .expect("ChatGPT smoke inference did not complete.");
        let output = extract_output_text(&value, "verify the ChatGPT connection")
            .expect("ChatGPT smoke inference returned no text.");
        assert!(
            output.trim() == "ORION_CONNECTION_OK",
            "ChatGPT smoke inference did not return the required synthetic marker."
        );
        // Only non-secret counts leave the test; never print the credential store.
        println!("ChatGPT connection verified: configured={}, saved_accounts={}, connected_accounts={}, selectable_models={}, inference_completed=true, elapsed_ms={}",
            state.configured, state.accounts.len(), state.accounts.iter().filter(|a| a.connected).count(), models.len(), started.elapsed().as_millis());
    }
    fn account(id: &str) -> Account {
        Account {
            id: id.into(),
            subject: "subject-a".into(),
            email: "same@example.test".into(),
            access: "old-access".into(),
            refresh: "old-refresh".into(),
            identity: "old-identity".into(),
            expires: now() + 3600,
            scopes: vec![PLAN_SCOPE.into()],
        }
    }
    fn legacy_fixture(store: &Store) -> (Manifest, HashMap<String, String>) {
        let encoded = BASE64_STANDARD.encode(encode_store(store).unwrap().as_bytes());
        let manifest = Manifest {
            generation: "41f7f60e-1bc7-4115-9285-2b4cb121f9c2".into(),
            parts: encoded.len().div_ceil(1800),
        };
        let mut entries = HashMap::from([(
            "chatgpt-plan".into(),
            serde_json::to_string(&manifest).unwrap(),
        )]);
        for (index, part) in encoded.as_bytes().chunks(1800).enumerate() {
            entries.insert(
                chunk_name(&manifest, index),
                std::str::from_utf8(part).unwrap().into(),
            );
        }
        (manifest, entries)
    }
    #[test]
    fn legacy_multipart_credentials_preserve_all_accounts_registration_and_active_selection() {
        let mut first = account("oaiapp_first");
        first.access = "synthetic-access-".repeat(400);
        let store = Store {
            host: "urn:uuid:synthetic-installation".into(),
            active: Some("oaiapp_second".into()),
            accounts: vec![first, account("oaiapp_second")],
            welcomed: true,
        };
        let (manifest, entries) = legacy_fixture(&store);
        assert!(manifest.parts > 3);
        let mut reads = Vec::new();
        let (restored, restored_manifest) = read_legacy_store(|name| {
            reads.push(name.to_owned());
            Ok(entries.get(name).cloned().map(Zeroizing::new))
        })
        .unwrap()
        .unwrap();
        assert_eq!(reads.len(), manifest.parts + 1);
        assert_eq!(restored_manifest.generation, manifest.generation);
        assert_eq!(restored.host, store.host);
        assert_eq!(restored.active, store.active);
        assert_eq!(restored.welcomed, store.welcomed);
        assert_eq!(
            encode_store(&restored).unwrap().as_str(),
            encode_store(&store).unwrap().as_str()
        );
    }
    #[test]
    fn legacy_migration_rejects_incomplete_or_invalid_records_before_publication() {
        let (manifest, original) = legacy_fixture(&Store {
            accounts: vec![account("oaiapp_saved")],
            ..Store::default()
        });
        let first = chunk_name(&manifest, 0);
        for mutation in 0..4 {
            let mut entries = original.clone();
            match mutation {
                0 => {
                    entries.remove(&first);
                }
                1 => {
                    entries.insert(first.clone(), "x".repeat(1801));
                }
                2 => {
                    entries.insert(
                        first.clone(),
                        BASE64_STANDARD.encode(b"not valid store JSON"),
                    );
                }
                _ => {
                    entries.insert(
                        "chatgpt-plan".into(),
                        r#"{"generation":"invalid","parts":1}"#.into(),
                    );
                }
            }
            assert!(
                read_legacy_store(|name| Ok(entries.get(name).cloned().map(Zeroizing::new)))
                    .is_err()
            );
        }
        assert!(read_legacy_store(|_| Ok(None)).unwrap().is_none());
        assert!(decode_store(&vec![b' '; MAX_STORE_BYTES + 1]).is_err());
    }
    #[test]
    fn legacy_retirement_keeps_manifest_for_partial_failure_retry_and_removes_it_last() {
        let mut saved = account("oaiapp_saved");
        saved.access = "synthetic-access-".repeat(400);
        let (manifest, mut entries) = legacy_fixture(&Store {
            accounts: vec![saved],
            ..Store::default()
        });
        let failed = chunk_name(&manifest, 1);
        let mut attempted = Vec::new();
        let result = retire_legacy_parts(&manifest, |name| {
            attempted.push(name.to_owned());
            if name == failed {
                return Err("simulated locked entry".into());
            }
            entries.remove(name);
            Ok(())
        });
        assert!(result.is_err());
        assert!(entries.contains_key("chatgpt-plan"));
        assert!(entries.contains_key(&failed));
        assert!(!entries.contains_key(&chunk_name(&manifest, 0)));
        assert_eq!(attempted, vec![chunk_name(&manifest, 0), failed]);
        assert!(entries.contains_key(&chunk_name(&manifest, 2)));
        let retry_manifest = read_manifest(entries.get("chatgpt-plan").unwrap()).unwrap();
        let mut removals = Vec::new();
        retire_legacy_parts(&retry_manifest, |name| {
            removals.push(name.to_owned());
            entries.remove(name); // Already deleted entries are an idempotent success.
            Ok(())
        })
        .unwrap();
        assert!(entries.is_empty());
        assert_eq!(removals.last().map(String::as_str), Some("chatgpt-plan"));
    }
    #[test]
    fn authorization_uses_fresh_pkce_and_exact_registration_context() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let redirect = "http://127.0.0.1:32123/auth/callback";
        let url = authorization_url(
            "urn:uuid:host",
            None,
            redirect,
            "state+a",
            "nonce+b",
            verifier,
        );
        assert_eq!(url.origin().ascii_serialization(), ISSUER);
        let query = url.query_pairs().into_owned().collect::<HashMap<_, _>>();
        assert_eq!(query["client_id"], "dynamic_agent_client");
        assert_eq!(query["agent_name_hint"], "Orion");
        assert_eq!(query["redirect_uri"], redirect);
        assert_eq!(query["state"], "state+a");
        assert_eq!(query["nonce"], "nonce+b");
        assert_eq!(query["code_challenge_method"], "S256");
        assert_eq!(
            query["code_challenge"],
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert!(query["scope"]
            .split_whitespace()
            .any(|scope| scope == PLAN_SCOPE));
        assert!(!query.contains_key("id_token_hint"));
        let saved = account("oaiapp_saved");
        let url = authorization_url(
            "urn:uuid:host",
            Some(&saved),
            redirect,
            "new-state",
            "new-nonce",
            verifier,
        );
        let query = url.query_pairs().into_owned().collect::<HashMap<_, _>>();
        assert_eq!(query["client_id"], saved.id);
        assert_eq!(query["id_token_hint"], saved.identity);
        assert!(!query.contains_key("agent_name_hint"));
        assert_eq!(query["ext_agent_host_id"], "urn:uuid:host");
        let first = random().unwrap();
        let second = random().unwrap();
        assert_eq!(first.len(), 43);
        assert_eq!(URL_SAFE_NO_PAD.decode(&first).unwrap().len(), 32);
        assert_ne!(first, second);
    }
    #[test]
    fn unrelated_or_duplicate_state_callbacks_cannot_consume_pending_sign_in() {
        for target in [
            "/auth/callback?state=wrong&code=x&code=y",
            "/auth/callback?state=right&state=right&code=x",
            "/auth/callback?state=right&code=x#ignored",
            "/elsewhere?state=right&code=x",
        ] {
            assert!(!callback_has_state(target, "right"));
            assert!(callback(target, "right", Some("oaiapp_saved"))
                .unwrap_err()
                .contains("state did not match"));
        }
        assert!(callback_has_state(
            "/auth/callback?state=right&error=access_denied",
            "right"
        ));
        assert!(callback(
            "/auth/callback?state=right&code=x&code=y",
            "right",
            Some("oaiapp_saved")
        )
        .is_err());
    }
    #[tokio::test]
    async fn cancellation_drops_pending_exchange_and_rejects_late_completion() {
        let generation = AtomicU64::new(1);
        let finished = std::sync::atomic::AtomicBool::new(false);
        let work = async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            finished.store(true, Ordering::SeqCst);
            Ok::<_, String>(())
        };
        let cancel = async {
            tokio::time::sleep(Duration::from_millis(5)).await;
            generation.store(2, Ordering::SeqCst);
        };
        let (result, _) = tokio::time::timeout(Duration::from_secs(1), async {
            tokio::join!(while_sign_in_current(&generation, 1, work), cancel)
        })
        .await
        .unwrap();
        assert!(result.unwrap_err().contains("cancelled"));
        assert!(!finished.load(Ordering::SeqCst));
        assert!(
            while_sign_in_current(&generation, 1, async { Ok::<_, String>(()) })
                .await
                .is_err()
        );
    }
    #[test]
    fn new_authorization_requires_fresh_scope_and_refresh_but_refresh_retains_omitted_values() {
        let mut saved = account("oaiapp_saved");
        let before = serde_json::to_value(&saved).unwrap();
        for value in [
            json!({"access_token":"new-access","refresh_token":"new-refresh"}),
            json!({"access_token":"new-access","scope":PLAN_SCOPE}),
            json!({"access_token":"new-access","refresh_token":"new-refresh","scope":"openid"}),
        ] {
            assert!(apply_tokens(&mut saved, &value, true).is_err());
            assert_eq!(serde_json::to_value(&saved).unwrap(), before);
        }
        apply_tokens(
            &mut saved,
            &json!({"access_token":"new-access","expires_in":120}),
            false,
        )
        .unwrap();
        assert_eq!(saved.refresh, "old-refresh");
        assert_eq!(saved.scopes, vec![PLAN_SCOPE]);
        apply_tokens(&mut saved, &json!({"access_token":"rotated-access","refresh_token":"rotated-refresh","scope":PLAN_SCOPE}), false).unwrap();
        assert_eq!(saved.access, "rotated-access");
        assert_eq!(saved.refresh, "rotated-refresh");
    }
    #[test]
    fn only_terminal_refresh_errors_invalidate_credentials_and_preserve_registration() {
        for code in [
            "invalid_grant",
            "invalid_refresh_token",
            "token_expired",
            "refresh_token_expired",
            "refresh_token_invalidated",
            "refresh_token_reused",
        ] {
            assert!(token_error(400, &json!({"error":code})).invalidates_session);
            assert!(token_error(401, &json!({"error":{"code":code}})).invalidates_session);
        }
        for (status, value) in [
            (503, json!({"error":"temporarily_unavailable"})),
            (400, json!({"error":"invalid_client"})),
            (401, Value::Null),
        ] {
            assert!(!token_error(status, &value).invalidates_session);
        }
        let mut saved = account("oaiapp_saved");
        clear_tokens(&mut saved);
        assert_eq!(saved.id, "oaiapp_saved");
        assert_eq!(saved.subject, "subject-a");
        assert_eq!(saved.email, "same@example.test");
        assert!(saved.access.is_empty() && saved.refresh.is_empty() && saved.identity.is_empty());
        assert!(!connected(&saved));
    }
    #[test]
    fn duplicate_account_emails_keep_distinct_stable_labels_and_only_active_credentials_enable_status(
    ) {
        let mut store = Store {
            host: "host".into(),
            active: Some("oaiapp_second".into()),
            accounts: vec![account("oaiapp_first1"), account("oaiapp_second")],
            welcomed: true,
        };
        let labels = status(&store, false);
        assert!(labels.configured);
        assert_ne!(labels.accounts[0].email, labels.accounts[1].email);
        assert!(labels.accounts[0].email.ends_with("first1"));
        clear_tokens(&mut store.accounts[1]);
        assert!(!status(&store, false).configured);
        assert!(connected(&store.accounts[0]));
    }
    #[test]
    fn drawing_catalog_uses_only_the_selected_accounts_listed_models_and_efforts() {
        let response = json!({"models":[
          {"slug":"gpt-6.1-astra","visibility":"list","supported_reasoning_levels":[{"effort":"high"},{"effort":"xhigh"}]},
          {"slug":"gpt-9-astra","visibility":"hide"},
          {"slug":"gpt-6.2-sol","visibility":"list"}
        ]});
        assert_eq!(
            drawing_model_items(&response, true).unwrap(),
            json!([{"id":"chatgpt:gpt-6.1-astra","efforts":["high","xhigh"]}])
        );
        assert!(drawing_model_items(&response, false).is_err());
        let api = json!({"data":[{"id":"gpt-6-astra-2026-05-01"},{"id":"gpt-5.6-sol"}]});
        assert_eq!(
            drawing_model_items(&api, false).unwrap(),
            json!([{"id":"gpt-6-astra-2026-05-01"}])
        );
        assert_eq!(
            drawing_model_items(&api, true).unwrap(),
            json!([{"id":"chatgpt:gpt-6-astra-2026-05-01"}])
        );
    }

    #[test]
    fn model_catalog_keeps_account_order_and_excludes_hidden_or_invalid_slugs() {
        let models = model_catalog(&json!({"models":[
            {"slug":"gpt-6.1-sol","display_name":"Sol","visibility":"list"},
            {"slug":"hidden","visibility":"hidden"},
            {"slug":"invalid/slash","visibility":"list"},
            {"slug":"gpt-6-astra","visibility":"list"}
        ]}))
        .unwrap();
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["chatgpt:gpt-6.1-sol", "chatgpt:gpt-6-astra"]
        );
        assert_eq!(models[0].name, "Sol");
        assert!(model_catalog(&json!({"data":[]})).is_err());
    }
    #[tokio::test]
    async fn visual_streams_forward_only_text_deltas_and_require_terminal_completion() {
        let envelopes = [
            (
                false,
                vec![
                    json!({"type":"response.output_text.delta","delta":"public"}),
                    json!({"type":"response.completed","response":{"status":"completed","output_text":"final"}}),
                ],
            ),
            (
                true,
                vec![
                    json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
                    json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"private"}}),
                    json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"public"}}),
                    json!({"type":"message_delta","delta":{"stop_reason":"end_turn"}}),
                    json!({"type":"message_stop"}),
                ],
            ),
        ];
        for (anthropic, events) in envelopes {
            let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
            let captured = seen.clone();
            let channel = tauri::ipc::Channel::<String>::new(move |value| {
                if let tauri::ipc::InvokeResponseBody::Json(text) = value {
                    captured
                        .lock()
                        .unwrap()
                        .push(serde_json::from_str(&text).unwrap());
                }
                Ok(())
            });
            let frames = events
                .iter()
                .map(|event| format!("data: {event}\r\n\r\n"))
                .collect::<Vec<_>>();
            let result = read_visual_stream(
                response_fixture("text/event-stream", &frames.concat()).await,
                anthropic,
                &channel,
            )
            .await
            .unwrap();
            assert_eq!(seen.lock().unwrap().concat(), "public");
            if anthropic {
                assert_eq!(result["content"][0]["text"], "public");
            } else {
                assert_eq!(result["output_text"], "final");
            }
            assert!(read_visual_stream(
                response_fixture("text/event-stream", &frames[..frames.len() - 1].concat()).await,
                anthropic,
                &channel
            )
            .await
            .is_err());
        }
    }

    async fn response_fixture(content_type: &str, body: &str) -> Response {
        response_fixture_with_type(Some(content_type), body).await
    }
    async fn response_fixture_with_type(content_type: Option<&str>, body: &str) -> Response {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let content_type = content_type
            .map(|value| format!("Content-Type: {value}\r\n"))
            .unwrap_or_default();
        let response = format!("HTTP/1.1 200 OK\r\n{content_type}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 4096];
            socket.read(&mut request).await.unwrap();
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        Client::new()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap()
    }
    // Exercise the real shared outbound builder over HTTP. The fixture negotiates
    // its representation from Accept, as a provider does, rather than returning SSE
    // regardless of what Orion requested.
    async fn text_request_fixture(
        body: Value,
        completed: Value,
        terminal: bool,
    ) -> (
        Response,
        tokio::task::JoinHandle<(reqwest::header::HeaderMap, Value)>,
    ) {
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let captured = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let header_end = loop {
                let mut chunk = [0; 4096];
                let read = socket.read(&mut chunk).await.unwrap();
                assert!(read > 0 && bytes.len() + read <= 512 * 1024);
                bytes.extend_from_slice(&chunk[..read]);
                if let Some(end) = bytes.windows(4).position(|s| s == b"\r\n\r\n") {
                    break end + 4;
                }
            };
            let mut headers = reqwest::header::HeaderMap::new();
            for line in std::str::from_utf8(&bytes[..header_end])
                .unwrap()
                .lines()
                .skip(1)
                .filter(|line| !line.is_empty())
            {
                let (name, value) = line.split_once(':').unwrap();
                headers.insert(
                    reqwest::header::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                    reqwest::header::HeaderValue::from_str(value.trim()).unwrap(),
                );
            }
            let length = headers[reqwest::header::CONTENT_LENGTH]
                .to_str()
                .unwrap()
                .parse::<usize>()
                .unwrap();
            assert!(length <= 512 * 1024);
            while bytes.len() < header_end + length {
                let mut chunk = [0; 4096];
                let read = socket.read(&mut chunk).await.unwrap();
                assert!(read > 0 && bytes.len() + read <= 512 * 1024);
                bytes.extend_from_slice(&chunk[..read]);
            }
            let body = serde_json::from_slice(&bytes[header_end..header_end + length]).unwrap();
            let stream = headers.get(reqwest::header::ACCEPT).unwrap() == "text/event-stream";
            let (content_type, response_body) = if stream {
                let mut events = format!(
                    "data: {}\n\n",
                    json!({"type":"response.output_text.delta","delta":"not authoritative"})
                );
                if terminal {
                    events.push_str(&format!(
                        "data: {}\n\n",
                        json!({"type":"response.completed","response":completed})
                    ));
                }
                ("text/event-stream", events)
            } else {
                ("application/json", completed.to_string())
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}",
                response_body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            (headers, body)
        });
        let response = text_request(
            provider_http_client()
                .unwrap()
                .post(format!("http://{address}/v1/responses"))
                .bearer_auth("synthetic-test-credential"),
            body,
        )
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .unwrap();
        (response, captured)
    }
    #[tokio::test]
    async fn outgoing_chat_and_suggestion_requests_negotiate_their_expected_response_format() {
        let context = json!({
            "spaceId":"synthetic-space", "spaceName":"Prototype tests", "attachedNoteId":null,
            "evidence":[{"id":"passage-1","kind":"note","entityId":"prototype","title":"Battery trial","text":"The prototype's battery life is uncertain. We must choose whether to run a short pilot before ordering components."}],
            "directory":[{"id":"prototype","title":"Battery trial"}], "previousPrompts":[]
        });
        let context = validate_chat_suggestion_context(Some(&context.to_string())).unwrap();
        for model in ["chatgpt:gpt-6.1-sol", "gpt-6.1-sol"] {
            for suggestions in [false, true] {
                let schema = if suggestions {
                    chat_suggestions_protocol()["schema"].clone()
                } else {
                    chat_edit_schema(true, false, false)
                };
                let output = if suggestions {
                    json!({"suggestions":[{"prompt":"Which trial would resolve the uncertain battery life?","intent":"discuss","evidenceIds":["passage-1"]},{"prompt":"How would a short pilot affect the decision to order components?","intent":"discuss","evidenceIds":["passage-1"]}]})
                } else {
                    json!({"reply":"Synthetic chat reply"})
                };
                let input = if suggestions {
                    json!({"suggestionContext":context})
                } else {
                    json!({"question":"What would a battery trial tell us?","workspaceName":"Prototype tests","conversation":[],"notes":[],"sources":[],"concepts":[]})
                };
                let format =
                    json!({"type":"json_schema","name":"orion_chat","strict":true,"schema":schema});
                let body = json!({"model":model,"store":false,"max_output_tokens":6000,"input":input.to_string(),"text":{"format":format},"reasoning":{"effort":"low"}});
                let original = body.clone();
                let completed = json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":output.to_string()}]}]});
                let (response, captured) = text_request_fixture(body, completed, true).await;
                let result = read_for_model(response, model).await.unwrap();
                let output_text = extract_output_text(&result, "test the text transport").unwrap();
                assert_eq!(output_text, output.to_string());
                let parsed = if suggestions {
                    let parsed = parse_chat_suggestion_result(&output_text, &context).unwrap();
                    assert_eq!(
                        serde_json::to_value(parsed.suggestions.as_ref().unwrap()).unwrap(),
                        output["suggestions"]
                    );
                    assert!(parsed.reply.is_empty());
                    parsed
                } else {
                    let parsed =
                        parse_chat_edit_response(&output_text, true, false, false).unwrap();
                    assert_eq!(parsed.reply, "Synthetic chat reply");
                    assert!(parsed.suggestions.is_none());
                    parsed
                };
                assert!(parsed.note_actions.is_empty());
                assert!(parsed.note_edits.is_empty());
                assert!(parsed.read_requests.is_none());
                let (headers, sent) = captured.await.unwrap();
                assert_eq!(headers[reqwest::header::CONTENT_TYPE], "application/json");
                assert_eq!(sent["text"]["format"], format);
                assert_eq!(sent["reasoning"], original["reasoning"]);
                if is_model(model) {
                    assert_eq!(headers[reqwest::header::ACCEPT], "text/event-stream");
                    assert_eq!(sent["model"], "gpt-6.1-sol");
                    assert_eq!(sent["stream"], true);
                    assert_eq!(sent["store"], false);
                    assert_eq!(sent["input"][0]["content"], original["input"]);
                    assert!(sent.get("max_output_tokens").is_none());
                } else {
                    assert_eq!(headers[reqwest::header::ACCEPT], "application/json");
                    assert_eq!(sent, original);
                }
            }
        }
    }
    #[tokio::test]
    async fn outgoing_plan_request_still_rejects_a_negotiated_stream_without_completion() {
        let model = "chatgpt:gpt-6.1-sol";
        let (response, captured) = text_request_fixture(
            json!({"model":model,"input":"Synthetic test context"}),
            json!({"status":"completed","output":[]}),
            false,
        )
        .await;
        assert!(read_for_model(response, model)
            .await
            .unwrap_err()
            .contains("without a completed"));
        assert_eq!(
            captured.await.unwrap().0[reqwest::header::ACCEPT],
            "text/event-stream"
        );
    }
    #[tokio::test]
    async fn plan_stream_without_content_type_still_requires_valid_terminal_completion() {
        let complete = "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n";
        for content_type in [None, Some(""), Some(" \t ")] {
            assert_eq!(
                read_for_model(
                    response_fixture_with_type(content_type, complete).await,
                    "chatgpt:gpt-6.1-sol"
                )
                .await
                .unwrap()["status"],
                "completed"
            );
            assert_eq!(
                read_with_limit(
                    response_fixture_with_type(content_type, complete).await,
                    4096
                )
                .await
                .unwrap()["status"],
                "completed"
            );
            for incomplete in [
                "",
                "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\ndata: [DONE]\n\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}",
                "{\"status\":\"completed\",\"output\":[]}",
            ] {
                assert!(read_with_limit(
                    response_fixture_with_type(content_type, incomplete).await,
                    4096
                )
                .await
                .unwrap_err()
                .contains("without a completed"));
            }
            for (event, error) in [
                (
                    json!({"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded"}}}),
                    "Manage usage",
                ),
                (
                    json!({"type":"error","code":"subscription_sharing_usage_unavailable"}),
                    "temporarily unavailable",
                ),
                (json!({"type":"response.incomplete"}), "incomplete response"),
                (
                    json!({"type":"response.completed","response":{"status":"incomplete"}}),
                    "incomplete response",
                ),
            ] {
                assert!(read_with_limit(
                    response_fixture_with_type(content_type, &format!("data: {event}\n\n")).await,
                    4096
                )
                .await
                .unwrap_err()
                .contains(error));
            }
            assert!(read_with_limit(
                response_fixture_with_type(content_type, &"x".repeat(4097)).await,
                4096
            )
            .await
            .unwrap_err()
            .contains("limit"));
        }
        // A missing header on ordinary API-key JSON retains the original route.
        assert_eq!(
            read_for_model(
                response_fixture_with_type(None, "{\"status\":\"completed\",\"output\":[]}").await,
                "gpt-6.1-sol"
            )
            .await
            .unwrap()["status"],
            "completed"
        );
        // An explicitly incompatible MIME is rejected even when the body is SSE.
        assert!(read_for_model(
            response_fixture("application/json", complete).await,
            "chatgpt:gpt-6.1-sol"
        )
        .await
        .unwrap_err()
        .contains("did not return a completed response stream"));
    }
    #[tokio::test]
    async fn plan_transport_requires_terminal_sse_but_api_key_json_still_works() {
        let json = r#"{"status":"completed","output":[]}"#;
        assert!(read_for_model(
            response_fixture("application/json", json).await,
            "chatgpt:gpt-6.1-sol"
        )
        .await
        .is_err());
        assert_eq!(
            read_for_model(
                response_fixture("application/json", json).await,
                "gpt-6.1-sol"
            )
            .await
            .unwrap()["status"],
            "completed"
        );
        let sse = "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[]}}\n\n";
        assert_eq!(
            read_for_model(
                response_fixture("Text/Event-Stream; charset=utf-8", sse).await,
                "chatgpt:gpt-6.1-sol"
            )
            .await
            .unwrap()["status"],
            "completed"
        );
        let incomplete = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\ndata: [DONE]\n\n";
        assert!(read_with_limit(
            response_fixture("text/event-stream", incomplete).await,
            4096
        )
        .await
        .unwrap_err()
        .contains("without a completed"));
        assert!(
            read_with_limit(response_fixture("text/event-stream", sse).await, 4)
                .await
                .unwrap_err()
                .contains("limit")
        );
    }
    #[test]
    fn rejects_cross_account_and_unverified_callbacks() {
        assert!(callback(
            "/auth/callback?state=wrong&code=x&client_id=oaiapp_a",
            "right",
            None
        )
        .is_err());
        assert!(callback(
            "/auth/callback?state=right&state=right&code=x&client_id=oaiapp_a",
            "right",
            None
        )
        .is_err());
        assert!(callback(
            "/auth/callback?state=right&code=x&client_id=oaiapp_b",
            "right",
            Some("oaiapp_a")
        )
        .is_err());
        assert!(callback("/auth/callback?state=right&code=x", "right", None).is_err());
        assert!(callback(
            "/auth/callback?state=right&error=access_denied",
            "right",
            Some("oaiapp_a")
        )
        .is_err());
        assert_eq!(
            callback(
                "/auth/callback?state=right&code=x",
                "right",
                Some("oaiapp_a")
            )
            .unwrap()
            .1,
            "oaiapp_a"
        );
    }
    #[test]
    fn plan_body_has_only_supported_fields() {
        let mut body = json!({"model":"chatgpt:gpt-6.1-sol","input":"private note", "max_output_tokens":12000,"store":true,"text":{"format":{"type":"json_schema"}}});
        assert!(prepare(&mut body));
        assert_eq!(body["model"], "gpt-6.1-sol");
        assert_eq!(body["stream"], true);
        assert_eq!(body["store"], false);
        assert!(body.get("max_output_tokens").is_none());
        assert!(body["input"].is_array());
    }
    #[test]
    fn fragmented_stream_requires_terminal_completion() {
        let mut events = Events::default();
        assert!(events
            .feed(b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n")
            .unwrap()
            .is_none());
        assert!(events
            .feed(b"data: {\"type\":\"response.com")
            .unwrap()
            .is_none());
        assert_eq!(
            events
                .feed(b"pleted\",\"response\":{\"status\":\"completed\",\"output\":[]}}\r\n\r\n")
                .unwrap()
                .unwrap()["status"],
            "completed"
        );
        let mut events = Events::default();
        assert!(events.feed(b"data: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"subscription_sharing_usage_limit_exceeded\"}}}\n\n").unwrap_err().contains("Manage usage"));
    }
    #[test]
    fn plan_failure_frames_show_actionable_categories_and_keep_provider_text_private() {
        for (event, expected) in [
            (
                json!({"type":"response.failed","response":{"error":{"code":"context_length_exceeded","message":"private note"}}}),
                "context window",
            ),
            (
                json!({"type":"error","error":{"code":null,"type":"rate_limit_error"}}),
                "limiting requests",
            ),
            (
                json!({"type":"error","code":"server_error"}),
                "temporary service error",
            ),
            (
                json!({"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}),
                "output limit",
            ),
            (
                json!({"type":"error","code":"private note","message":"private note"}),
                "without a recognized reason",
            ),
        ] {
            let message = Events::default()
                .feed(format!("data: {event}\n\n").as_bytes())
                .unwrap_err();
            assert!(message.contains(expected), "{message}");
            assert!(!message.contains("private note"));
        }
        assert!(plan_error(503, "").contains("HTTP 503"));
        assert!(plan_error(400, "private note").contains("HTTP 400"));
    }

    #[test]
    fn stream_boundaries_preserve_utf8_and_never_accept_failed_or_incomplete_output() {
        let frame = "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output_text\":\"Héllo 🫠\"}}\r\n\r\n";
        for split in 1..frame.len() {
            let mut events = Events::default();
            assert!(events.feed(&frame.as_bytes()[..split]).unwrap().is_none());
            assert_eq!(
                events.feed(&frame.as_bytes()[split..]).unwrap().unwrap()["output_text"],
                "Héllo 🫠"
            );
        }
        for frame in [
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"incomplete\",\"output_text\":\"partial\"}}\n\n",
            "data: {\"type\":\"response.incomplete\",\"response\":{\"output_text\":\"partial\"}}\n\n",
            "data: {\"type\":\"error\",\"code\":\"subscription_sharing_usage_unavailable\"}\n\n",
        ] {
            assert!(Events::default().feed(frame.as_bytes()).is_err());
        }
    }

    fn finished_fixture_item(id: &str, item_type: &str) -> Value {
        if item_type == "web_search_call" {
            json!({"id":id,"type":item_type,"status":"completed","action":{"type":"search"}})
        } else {
            json!({"id":id,"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"A synthetic cited answer 🦉.","annotations":[{"type":"url_citation","url":"https://example.com","title":"Example","start_index":2,"end_index":12}]}]})
        }
    }
    fn event_frame(value: Value) -> Vec<u8> {
        format!("data: {value}\n\n").into_bytes()
    }

    #[test]
    fn finalized_items_survive_empty_or_subset_terminal_output_in_protocol_order() {
        let search = finished_fixture_item("ws_one", "web_search_call");
        let message = finished_fixture_item("msg_one", "message");
        for terminal in [
            json!([]),
            json!([message.clone()]),
            json!([search.clone(), message.clone()]),
            Value::Null,
        ] {
            let mut events = Events::default();
            // Actual streams may finish items out of order. Exact duplicate
            // delivery must not produce duplicate citations or assistant text.
            for (index, item) in [
                (1, message.clone()),
                (0, search.clone()),
                (1, message.clone()),
            ] {
                assert!(events
                    .feed(&event_frame(
                        json!({"type":"response.output_item.done","output_index":index,"item":item})
                    ))
                    .unwrap()
                    .is_none());
            }
            let response=events.feed(&event_frame(json!({"type":"response.completed","response":{"id":"resp_one","status":"completed","output":terminal}}))).unwrap().unwrap();
            assert_eq!(response["output"], json!([search.clone(), message.clone()]));
        }
        let mut events = Events::default();
        let mut item = message.clone();
        item.as_object_mut().unwrap().remove("id");
        item.as_object_mut().unwrap().remove("status");
        assert!(events
            .feed(&event_frame(
                json!({"type":"response.output_item.done","item":item})
            ))
            .unwrap()
            .is_none());
        assert!(events
            .feed(&event_frame(
                json!({"type":"response.output_item.done","item":item})
            ))
            .unwrap()
            .is_none());
        assert_eq!(
            events
                .feed(&event_frame(
                    json!({"type":"response.completed","response":{"status":"completed"}})
                ))
                .unwrap()
                .unwrap()["output"],
            json!([item])
        );
    }

    #[tokio::test]
    async fn finished_items_are_never_published_without_successful_terminal_completion() {
        let done = event_frame(
            json!({"type":"response.output_item.done","output_index":0,"item":finished_fixture_item("ws_one","web_search_call")}),
        );
        let response =
            response_fixture("text/event-stream", std::str::from_utf8(&done).unwrap()).await;
        assert!(read_for_model(response, "chatgpt:gpt-6.1-sol")
            .await
            .unwrap_err()
            .contains("without a completed response"));
        for terminal in [
            json!({"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_unavailable"}}}),
            json!({"type":"response.incomplete"}),
            json!({"type":"error"}),
            json!({"type":"response.completed","response":{"status":"incomplete"}}),
        ] {
            let mut events = Events::default();
            assert!(events.feed(&done).unwrap().is_none());
            assert!(events.feed(&event_frame(terminal)).is_err());
        }
        let mut events = Events::default();
        events.feed(&event_frame(json!({"type":"response.output_item.added","output_index":0,"item":finished_fixture_item("ws_partial","web_search_call")}))).unwrap();
        let response = events
            .feed(&event_frame(
                json!({"type":"response.completed","response":{"status":"completed","output":[]}}),
            ))
            .unwrap()
            .unwrap();
        assert_eq!(response["output"], json!([]));
        let mut failed = finished_fixture_item("ws_failed", "web_search_call");
        failed["status"] = json!("failed");
        assert!(Events::default()
            .feed(&event_frame(
                json!({"type":"response.output_item.done","item":failed})
            ))
            .is_err());
    }

    #[test]
    fn finalized_item_conflicts_and_resource_bounds_fail_closed() {
        let first = finished_fixture_item("msg_one", "message");
        let mut changed = first.clone();
        changed["content"][0]["text"] = json!("Contradictory completed content");
        for (index, item) in [
            (0, changed.clone()),
            (1, first.clone()),
            (0, finished_fixture_item("other_id", "message")),
        ] {
            let mut events = Events::default();
            events
                .feed(&event_frame(
                    json!({"type":"response.output_item.done","output_index":0,"item":first}),
                ))
                .unwrap();
            assert!(events
                .feed(&event_frame(
                    json!({"type":"response.output_item.done","output_index":index,"item":item})
                ))
                .is_err());
        }
        let mut events = Events::default();
        events
            .feed(&event_frame(
                json!({"type":"response.output_item.done","output_index":0,"item":first}),
            ))
            .unwrap();
        assert!(events.feed(&event_frame(json!({"type":"response.completed","response":{"status":"completed","output":[changed]}}))).is_err());
        for index in [
            json!(-1),
            json!(1.5),
            json!(1024),
            json!(u64::MAX),
            Value::Null,
        ] {
            assert!(Events::default()
                .feed(&event_frame(
                    json!({"type":"response.output_item.done","output_index":index,"item":first})
                ))
                .is_err());
        }
        let mut items = vec![];
        Events::retain_finished(&mut items, first.clone(), None).unwrap();
        Events::retain_finished(
            &mut items,
            finished_fixture_item("other_id", "message"),
            Some(2),
        )
        .unwrap();
        assert!(Events::retain_finished(&mut items, first.clone(), Some(2)).is_err());
        let mut events = Events {
            limit: 64,
            ..Events::default()
        };
        assert!(events
            .feed(&event_frame(
                json!({"type":"response.output_item.done","item":first})
            ))
            .is_err());
        let mut items = vec![];
        for index in 0..1024 {
            Events::retain_finished(
                &mut items,
                json!({"type":"reasoning","id":format!("rs_{index}")}),
                None,
            )
            .unwrap();
        }
        assert!(Events::retain_finished(&mut items, json!({"type":"reasoning"}), None).is_err());
    }
}

#[cfg(test)]
mod identity_tests {
    use super::*;
    fn token(mut claims: Value) -> String {
        if claims.get("exp").is_none() {
            claims["exp"] = json!(now() + 60);
        }
        let mut header = jsonwebtoken::Header::new(Algorithm::RS256);
        header.kid = Some("test-key".into());
        let key = jsonwebtoken::EncodingKey::from_rsa_der(include_bytes!(
            "../tests/fixtures/chatgpt/test-only-key.der"
        ));
        jsonwebtoken::encode(&header, &claims, &key).unwrap()
    }
    #[test]
    fn requires_signature_issuer_audience_expiry_nonce_and_subject() {
        let keys: JwkSet =
            serde_json::from_str(include_str!("../tests/fixtures/chatgpt/jwks.json")).unwrap();
        let claims =
            json!({"iss":ISSUER,"aud":"oaiapp_test","sub":"user-a","iat":now(),"nonce":"expected"});
        let good = token(claims.clone());
        assert!(verify_identity(&good, "oaiapp_test", "expected", &keys).is_ok());
        assert!(verify_identity(&good, "oaiapp_other", "expected", &keys).is_err());
        assert!(verify_identity(&good, "oaiapp_test", "wrong", &keys).is_err());
        for (field, value) in [
            ("iss", json!("https://attacker.invalid")),
            ("sub", json!("")),
            ("exp", json!(now() - 60)),
        ] {
            let mut bad = claims.clone();
            bad[field] = value;
            assert!(verify_identity(&token(bad), "oaiapp_test", "expected", &keys).is_err());
        }
        let mut parts = good.split('.').map(str::to_string).collect::<Vec<_>>();
        parts[1]=URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({"iss":ISSUER,"aud":"oaiapp_test","sub":"other","exp":now()+60,"nonce":"expected"})).unwrap());
        assert!(verify_identity(&parts.join("."), "oaiapp_test", "expected", &keys).is_err());
    }
    #[test]
    fn identity_only_tokens_cannot_enable_plan_usage() {
        let mut account = Account {
            id: "oaiapp_test".into(),
            subject: "u".into(),
            email: String::new(),
            access: String::new(),
            refresh: String::new(),
            identity: String::new(),
            expires: 0,
            scopes: vec![],
        };
        assert!(apply_tokens(
            &mut account,
            &json!({"access_token":"a","refresh_token":"r","scope":"openid email"}),
            true
        )
        .is_err());
        assert!(!connected(&account));
        apply_tokens(
            &mut account,
            &json!({"access_token":"a","refresh_token":"r","scope":PLAN_SCOPE,"expires_in":60}),
            true,
        )
        .unwrap();
        assert!(connected(&account));
        apply_tokens(
            &mut account,
            &json!({"access_token":"b","refresh_token":"rotated","expires_in":60}),
            false,
        )
        .unwrap();
        assert_eq!(account.refresh, "rotated");
    }
}

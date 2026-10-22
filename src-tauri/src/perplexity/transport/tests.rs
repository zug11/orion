use super::*;
use serde_json::json;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex as StdMutex},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};

struct Reply {
    status: u16,
    headers: String,
    body: String,
    delay: Duration,
}
impl Reply {
    fn ok() -> Self {
        Self {
            status: 200,
            headers: String::new(),
            body: r#"{"id":"existing_run","status":"in_progress"}"#.into(),
            delay: Duration::ZERO,
        }
    }
    fn limited(seconds: u32, kind: &str, message: &str) -> Self {
        Self {
            status: 429,
            headers: format!("Retry-After: {seconds}\r\n"),
            body: json!({"error":{"type":kind,"message":message}}).to_string(),
            delay: Duration::ZERO,
        }
    }
}

struct Server {
    url: String,
    seen: Arc<StdMutex<Vec<(Instant, String)>>>,
    task: JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Server {
    // Loopback HTTP only: exercise actual reqwest admission, bodies and errors
    // without credentials, provider calls, or a vault.
    async fn start(replies: Vec<Option<Reply>>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let records = seen.clone();
        let task = tokio::spawn(async move {
            let mut replies = VecDeque::from(replies);
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut chunk = [0_u8; 4096];
                    let count = stream.read(&mut chunk).await.unwrap();
                    if count == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&chunk[..count]);
                    if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")
                                    .and_then(|n| n.parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                records
                    .lock()
                    .unwrap()
                    .push((Instant::now(), String::from_utf8(bytes).unwrap()));
                let Some(reply) = replies.pop_front().flatten() else {
                    continue;
                };
                tokio::time::sleep(reply.delay).await;
                let response = format!("HTTP/1.1 {} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n{}", reply.status, reply.body.len(), reply.headers, reply.body);
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        Self { url, seen, task }
    }
    async fn wait_for(&self, count: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while self.seen.lock().unwrap().len() < count {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
    }
}

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(15)
}
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .no_proxy()
        .build()
        .unwrap()
}

#[test]
fn retry_after_supports_seconds_and_http_dates() {
    let mut headers = header::HeaderMap::new();
    headers.insert(header::RETRY_AFTER, "12".parse().unwrap());
    assert_eq!(
        retry_after(&headers, UNIX_EPOCH),
        Some(Duration::from_secs(12))
    );
    headers.insert(
        header::RETRY_AFTER,
        "Wed, 21 Oct 2015 07:28:00 GMT".parse().unwrap(),
    );
    assert_eq!(
        retry_after(&headers, UNIX_EPOCH + Duration::from_secs(1_445_412_470)),
        Some(Duration::from_secs(10))
    );
    assert_eq!(
        retry_after(&headers, SystemTime::now()),
        Some(Duration::ZERO)
    );
    headers.insert(header::RETRY_AFTER, "not a time".parse().unwrap());
    assert_eq!(retry_after(&headers, UNIX_EPOCH), None);
}

#[tokio::test]
async fn workers_share_pacing_across_admission_and_polls() {
    let server = Server::start(vec![
        Some(Reply::ok()),
        Some(Reply::ok()),
        Some(Reply::ok()),
    ])
    .await;
    let client = client();
    let gate = RequestGate::default();
    let (_send, receiver) = watch::channel(false);
    let mut a = receiver.clone();
    let mut b = receiver.clone();
    let mut c = receiver;
    let (a, b, c) = tokio::join!(
        read_json(
            &gate,
            || client
                .post(format!("{}/agent", server.url))
                .json(&json!({"input":"public question"})),
            &mut a,
            deadline(),
            true
        ),
        read_json(
            &gate,
            || client.get(format!("{}/agent/first", server.url)),
            &mut b,
            deadline(),
            false
        ),
        read_json(
            &gate,
            || client.get(format!("{}/agent/second", server.url)),
            &mut c,
            deadline(),
            false
        ),
    );
    assert!(a.is_ok() && b.is_ok() && c.is_ok());
    let requests = server.seen.lock().unwrap();
    assert_eq!(requests.len(), 3);
    for pair in requests.windows(2) {
        assert!(pair[1].0.duration_since(pair[0].0) >= Duration::from_millis(1_050));
    }
}

#[tokio::test]
async fn retries_rate_limited_poll_on_same_run_after_retry_after() {
    let server = Server::start(vec![
        Some(Reply::limited(
            3,
            "request_rate_limit_exceeded",
            "private diagnostic",
        )),
        Some(Reply::ok()),
    ])
    .await;
    let client = client();
    let gate = RequestGate::default();
    let (_send, mut receiver) = watch::channel(false);
    let result = read_json(
        &gate,
        || client.get(format!("{}/agent/existing_run", server.url)),
        &mut receiver,
        deadline(),
        false,
    )
    .await
    .unwrap();
    assert_eq!(result["id"], "existing_run");
    let requests = server.seen.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests
        .iter()
        .all(|(_, request)| request.starts_with("GET /agent/existing_run HTTP/1.1")));
    assert!(requests[1].0.duration_since(requests[0].0) >= Duration::from_secs(3));
}

#[tokio::test]
async fn only_explicit_rejection_retries_a_paid_post() {
    let client = client();
    let gate = RequestGate::default();
    let (_send, mut receiver) = watch::channel(false);
    let server = Server::start(vec![
        Some(Reply::limited(0, "request_rate_limit_exceeded", "")),
        Some(Reply::ok()),
    ])
    .await;
    let body = json!({"input":"public question","background":true});
    read_json(
        &gate,
        || client.post(format!("{}/agent", server.url)).json(&body),
        &mut receiver,
        deadline(),
        true,
    )
    .await
    .unwrap();
    let requests = server.seen.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].1, requests[1].1);
    drop(requests);
    let interrupted = Server::start(vec![None, Some(Reply::ok())]).await;
    let error = read_json(
        &RequestGate::default(),
        || {
            client
                .post(format!("{}/agent", interrupted.url))
                .json(&body)
        },
        &mut receiver,
        deadline(),
        true,
    )
    .await
    .unwrap_err();
    assert!(error.contains("connection failed"));
    assert_eq!(
        interrupted.seen.lock().unwrap().len(),
        1,
        "An ambiguous admission must not start replacement work"
    );
}

#[tokio::test]
async fn cancellation_during_admission_retains_the_id_for_remote_cancel() {
    let mut reply = Reply::ok();
    reply.delay = Duration::from_millis(150);
    let server = Server::start(vec![Some(reply)]).await;
    let client = client();
    let gate = RequestGate::default();
    let (send, mut receiver) = watch::channel(false);
    let work = read_json(
        &gate,
        || client.post(format!("{}/agent", server.url)),
        &mut receiver,
        deadline(),
        true,
    );
    let cancel = async {
        server.wait_for(1).await;
        send.send(true).unwrap();
    };
    let (result, _) = tokio::join!(work, cancel);
    assert_eq!(result.unwrap()["id"], "existing_run");
    let blocked = read_json(
        &gate,
        || client.post(format!("{}/agent", server.url)),
        &mut receiver,
        deadline(),
        true,
    )
    .await
    .unwrap_err();
    assert!(blocked.contains("cancelled"));
    assert_eq!(server.seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn cancelling_a_queued_worker_releases_the_lane_without_http() {
    let server = Server::start(vec![Some(Reply::ok())]).await;
    let client = client();
    let gate = RequestGate::default();
    gate.0.lock().await.next = Some(Instant::now() + Duration::from_millis(250));
    let (send, mut cancelled) = watch::channel(false);
    let (_other_send, mut other) = watch::channel(false);
    let (first, second, _) = tokio::join!(
        read_json(
            &gate,
            || client.get(format!("{}/agent/cancelled", server.url)),
            &mut cancelled,
            deadline(),
            false
        ),
        read_json(
            &gate,
            || client.get(format!("{}/agent/kept", server.url)),
            &mut other,
            deadline(),
            false
        ),
        async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            send.send(true).unwrap();
        },
    );
    assert!(first.unwrap_err().contains("cancelled"));
    assert!(second.is_ok());
    let requests = server.seen.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].1.starts_with("GET /agent/kept "));
}

#[tokio::test]
async fn long_token_cooldown_is_shared_and_does_not_expose_provider_text() {
    let server = Server::start(vec![Some(Reply::limited(
        3_600,
        "token_rate_limit_exceeded",
        "TPH private query and key must stay hidden",
    ))])
    .await;
    let client = client();
    let gate = RequestGate::default();
    let (_send, mut receiver) = watch::channel(false);
    for _ in 0..2 {
        let error = read_json(
            &gate,
            || client.get(format!("{}/agent/existing", server.url)),
            &mut receiver,
            deadline(),
            false,
        )
        .await
        .unwrap_err();
        assert!(error.contains("hourly token allowance"));
        assert!(error.contains("WEB_TOKEN_HOUR_LIMIT"));
        assert!(!error.contains("private query"));
        assert!(!error.contains("key must stay hidden"));
    }
    assert_eq!(server.seen.lock().unwrap().len(), 1);
}

#[test]
fn retry_diagnostics_distinguish_request_token_and_capacity_limits() {
    for (kind, message, code) in [
        ("request_rate_limit_exceeded", "", "WEB_REQUEST_RATE_LIMIT"),
        ("token_rate_limit_exceeded", "TPM", "WEB_TOKEN_MINUTE_LIMIT"),
        ("token_rate_limit_exceeded", "", "WEB_TOKEN_RATE_LIMIT"),
        ("overloaded", "", "WEB_MODEL_OVERLOADED"),
        ("unexpected private data", "", "WEB_HTTP_429"),
    ] {
        let limit = rate_limit(
            &header::HeaderMap::new(),
            &json!({"error":{"type":kind,"message":message}}),
            0,
        );
        assert_eq!(limit.code, code);
        assert!(limit.delay >= Duration::from_secs(2));
        assert!(!limit.message(limit.delay).contains("private data"));
    }
}

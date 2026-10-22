//! One fair request lane for all Perplexity workers/windows. Background runs
//! remain parallel; only their short HTTP requests share pacing and cooldowns.
use reqwest::{header, RequestBuilder, StatusCode};
use serde_json::Value;
use std::{
    future::Future,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    sync::{watch, Mutex},
    time::Instant,
};

const REQUEST_SPACING: Duration = Duration::from_millis(1_100);
const MAX_RETRIES: u32 = 3;
const MAX_RESPONSE_BYTES: usize = 2_000_000;

#[derive(Default)]
pub(crate) struct RequestGate(Mutex<Schedule>);

#[derive(Default)]
struct Schedule {
    next: Option<Instant>,
    cooldown: Option<(Instant, RateLimit)>,
}

impl RequestGate {
    pub(super) async fn reset_cooldown(&self) {
        self.0.lock().await.cooldown = None;
    }
}

#[derive(Clone, Debug)]
struct RateLimit {
    delay: Duration,
    detail: &'static str,
    code: &'static str,
}

impl RateLimit {
    fn message(&self, remaining: Duration) -> String {
        format!(
            "{} Retry in about {} seconds. ({})",
            self.detail,
            remaining
                .as_secs()
                .saturating_add(u64::from(remaining.subsec_nanos() != 0))
                .max(1),
            self.code
        )
    }
}

fn retry_after(headers: &header::HeaderMap, now: SystemTime) -> Option<Duration> {
    let value = headers.get(header::RETRY_AFTER)?.to_str().ok()?.trim();
    // Agent API uses seconds. Also accept the standard HTTP-date form.
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(Duration::from_secs(seconds.min(86_400)));
    }
    let date =
        time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc2822).ok()?;
    let epoch = u64::try_from(date.unix_timestamp()).ok()?;
    Some(
        (UNIX_EPOCH + Duration::from_secs(epoch))
            .duration_since(now)
            .unwrap_or_default()
            .min(Duration::from_secs(86_400)),
    )
}

fn rate_limit(headers: &header::HeaderMap, body: &Value, attempt: u32) -> RateLimit {
    // Interpret only known categories. Never reflect a provider message, query,
    // credential, or arbitrary error text into diagnostics.
    let (detail, code) = match body["error"]["type"].as_str() {
        Some("request_rate_limit_exceeded") => (
            "Perplexity's shared request limit is busy.",
            "WEB_REQUEST_RATE_LIMIT",
        ),
        Some("token_rate_limit_exceeded") => {
            match body["error"]["message"].as_str().unwrap_or("") {
                message if message.contains("TPH") => (
                    "Perplexity's hourly token allowance is temporarily exhausted.",
                    "WEB_TOKEN_HOUR_LIMIT",
                ),
                message if message.contains("TPM") => (
                    "Perplexity's per-minute token allowance is temporarily exhausted.",
                    "WEB_TOKEN_MINUTE_LIMIT",
                ),
                _ => (
                    "Perplexity's token allowance is temporarily exhausted.",
                    "WEB_TOKEN_RATE_LIMIT",
                ),
            }
        }
        Some("overloaded") => (
            "Perplexity's research model is temporarily overloaded.",
            "WEB_MODEL_OVERLOADED",
        ),
        _ => (
            "Perplexity is temporarily rate limiting research.",
            "WEB_HTTP_429",
        ),
    };
    let backoff = Duration::from_secs(2_u64.pow(attempt.min(MAX_RETRIES) + 1));
    let jitter = Duration::from_millis(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_millis() as u64
            % 251,
    );
    RateLimit {
        delay: retry_after(headers, SystemTime::now())
            .unwrap_or_default()
            .max(backoff)
            + jitter,
        detail,
        code,
    }
}

async fn controlled<T>(
    future: impl Future<Output = T>,
    cancelled: &mut watch::Receiver<bool>,
    deadline: Instant,
) -> Result<T, String> {
    if *cancelled.borrow() {
        return Err("Web research was cancelled.".into());
    }
    tokio::select! {
        biased;
        _ = cancelled.changed() => Err("Web research was cancelled.".into()),
        _ = tokio::time::sleep_until(deadline) => Err("Web research reached its time limit. Retry a narrower question.".into()),
        result = future => Ok(result),
    }
}

async fn receive(
    request: RequestBuilder,
) -> Result<(StatusCode, header::HeaderMap, Value), String> {
    let mut response = request.send().await.map_err(|_| {
        "The Perplexity connection failed or timed out. Check your connection and retry."
            .to_string()
    })?;
    let status = response.status();
    let headers = response.headers().clone();
    if !status.is_success() && status != StatusCode::TOO_MANY_REQUESTS {
        return Err(super::http_error(status));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The Perplexity response was interrupted.".to_string())?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("The web response exceeded Orion's transport safety bound. The connection was stopped before parsing. (WEB_TRANSPORT_BOUND)".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = if status == StatusCode::TOO_MANY_REQUESTS {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    } else {
        serde_json::from_slice(&bytes).map_err(|_| {
            "Perplexity returned an unreadable response. Retry the request.".to_string()
        })?
    };
    Ok((status, headers, body))
}

/// Retry only explicit HTTP 429 rejection, never an ambiguous POST/network
/// failure. A poll retries the same ID; it never creates replacement work.
pub(super) async fn read_json(
    gate: &RequestGate,
    request: impl Fn() -> RequestBuilder,
    cancelled: &mut watch::Receiver<bool>,
    deadline: Instant,
    admission: bool,
) -> Result<Value, String> {
    for attempt in 0..=MAX_RETRIES {
        let mut slot = controlled(gate.0.lock(), cancelled, deadline).await?;
        let now = Instant::now();
        if slot
            .cooldown
            .as_ref()
            .is_some_and(|(until, _)| *until <= now)
        {
            slot.cooldown = None;
        }
        let ready = slot
            .next
            .unwrap_or(now)
            .max(slot.cooldown.as_ref().map_or(now, |(until, _)| *until));
        if ready >= deadline {
            return Err(slot.cooldown.as_ref().map_or_else(
                || "Web research is waiting for other requests and reached its time limit. Try again shortly.".into(),
                |(until, limit)| limit.message(until.saturating_duration_since(now)),
            ));
        }
        controlled(tokio::time::sleep_until(ready), cancelled, deadline).await?;
        slot.next = Some(Instant::now() + REQUEST_SPACING);
        // Once a POST may have been admitted, obtain its ID even if cancelled
        // meanwhile, so the caller can cancel the actual remote run.
        let response = if admission {
            receive(
                request().timeout(
                    deadline
                        .saturating_duration_since(Instant::now())
                        .min(Duration::from_secs(30)),
                ),
            )
            .await
        } else {
            controlled(receive(request()), cancelled, deadline).await?
        };
        let (status, headers, body) = response?;
        if status != StatusCode::TOO_MANY_REQUESTS {
            return Ok(body);
        }
        let limit = rate_limit(&headers, &body, attempt);
        let ready = Instant::now() + limit.delay;
        let exhausted = attempt == MAX_RETRIES || ready >= deadline;
        let message = limit.message(limit.delay);
        slot.cooldown = Some((ready, limit));
        drop(slot);
        if exhausted {
            return Err(message);
        }
    }
    unreachable!("bounded retry loop returns its final diagnostic")
}

#[cfg(test)]
mod tests;

//! `KEEP_ADDRESS_LOOKUP=ideal`: Ideal Postcodes' postcode lookup (PAF),
//! `GET /v1/postcodes/{postcode}?api_key=…`. One credit per postcode that
//! returns addresses; a postcode not found costs none.
//!
//! The key is a query parameter, so no URL is ever logged: errors carry
//! the status and Ideal's numeric `code` only (reqwest's errors with the
//! URL stripped). 200 `code 2000` is the addresses; 404 `4040` not found;
//! anything else (401 `4010` bad key, 402 `4020` no credit, 5xx, a 5 s
//! timeout) is unavailable.

use std::time::Duration;

use futures_util::future::BoxFuture;
use reqwest::{Client, StatusCode, Url};
use serde_json::Value;

use super::{AddressLookup, LookupAddress, LookupError, Sent};

pub const BASE_URL: &str = "https://api.ideal-postcodes.co.uk";
pub const TIMEOUT: Duration = Duration::from_secs(5);

pub struct Ideal {
    client: Client,
    base: Url,
    key: String,
}

impl Ideal {
    /// `base`: [`BASE_URL`], or a local mock in tests.
    pub fn new(key: &str, base: &str) -> Result<Self, String> {
        Self::with_timeout(key, base, TIMEOUT)
    }

    pub fn with_timeout(key: &str, base: &str, timeout: Duration) -> Result<Self, String> {
        let client = Client::builder()
            .timeout(timeout)
            // The key rides in the URL: never follow it anywhere else.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("ideal postcodes client: {}", e.without_url()))?;
        let base = Url::parse(base).map_err(|e| format!("ideal postcodes base url: {e}"))?;
        Ok(Self {
            client,
            base,
            key: key.to_owned(),
        })
    }

    fn url(&self, postcode: &str) -> Url {
        let mut url = self.base.clone();
        url.path_segments_mut()
            .expect("an http(s) base")
            .pop_if_empty()
            .extend(["v1", "postcodes", postcode]);
        url.query_pairs_mut().append_pair("api_key", &self.key);
        url
    }

    async fn get(&self, postcode: &str) -> Result<Vec<LookupAddress>, Sent> {
        let unavailable = |reached: bool, detail: String| Sent {
            error: LookupError::Unavailable(format!("ideal postcodes: {detail}")),
            reached,
        };
        let response = self
            .client
            .get(self.url(postcode))
            .send()
            .await
            // A refused connection never reached them: not counted.
            .map_err(|e| unavailable(!e.is_connect(), e.without_url().to_string()))?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        let code = body.get("code").and_then(Value::as_i64);
        match (status, code) {
            (StatusCode::OK, _) => {
                let found: Vec<LookupAddress> = body
                    .get("result")
                    .and_then(Value::as_array)
                    .map(|rows| rows.iter().map(address).collect())
                    .unwrap_or_default();
                if found.is_empty() {
                    Err(Sent::reached(LookupError::NotFound))
                } else {
                    Ok(found)
                }
            }
            (StatusCode::NOT_FOUND, _) | (_, Some(4040)) => {
                Err(Sent::reached(LookupError::NotFound))
            }
            (status, code) => Err(unavailable(
                true,
                format!(
                    "status {}, code {}",
                    status.as_u16(),
                    code.map_or("none".into(), |c| c.to_string())
                ),
            )),
        }
    }
}

fn address(row: &Value) -> LookupAddress {
    let field = |name: &str| {
        row.get(name)
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_owned()
    };
    LookupAddress {
        line1: field("line_1"),
        line2: field("line_2"),
        line3: field("line_3"),
        town: field("post_town"),
        postcode: field("postcode"),
    }
}

impl AddressLookup for Ideal {
    fn lookup<'a>(&'a self, postcode: &'a str) -> BoxFuture<'a, Result<Vec<LookupAddress>, Sent>> {
        Box::pin(self.get(postcode))
    }
}

//! Rate limits (in memory, per process: one machine per environment).
//! Keyed GCRA limiters from `governor`. An unknown email is limited
//! exactly like a known one, so a limit can't reveal which exist.

use std::num::NonZeroU32;
use std::time::Duration;

use governor::{DefaultKeyedRateLimiter, Quota, RateLimiter};

fn quota(burst: u32, one_per: Duration) -> Quota {
    Quota::with_period(one_per)
        .expect("non-zero period")
        .allow_burst(NonZeroU32::new(burst).expect("non-zero burst"))
}

pub struct Limits {
    /// Password checks (sign-in, step-up, password change) per client IP.
    pub password_ip: DefaultKeyedRateLimiter<String>,
    /// Password checks per email (lower-cased), known or not.
    pub password_email: DefaultKeyedRateLimiter<String>,
    /// Second-factor attempts per user.
    pub second_factor: DefaultKeyedRateLimiter<String>,
    /// Emails sent per recipient (codes, reset links).
    pub email: DefaultKeyedRateLimiter<String>,
    /// Link redemptions (invite, reset) and reset requests per client IP.
    pub links_ip: DefaultKeyedRateLimiter<String>,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            password_ip: RateLimiter::keyed(quota(20, Duration::from_secs(3))),
            password_email: RateLimiter::keyed(quota(5, Duration::from_secs(60))),
            second_factor: RateLimiter::keyed(quota(5, Duration::from_secs(60))),
            email: RateLimiter::keyed(quota(3, Duration::from_secs(120))),
            links_ip: RateLimiter::keyed(quota(20, Duration::from_secs(3))),
        }
    }
}

impl Limits {
    /// Forget keys whose limits have fully replenished (an hourly job).
    pub fn sweep(&self) {
        self.password_ip.retain_recent();
        self.password_email.retain_recent();
        self.second_factor.retain_recent();
        self.email.retain_recent();
        self.links_ip.retain_recent();
    }
}

/// Take one from `limiter` for `key`; false if over the limit.
pub fn allow(limiter: &DefaultKeyedRateLimiter<String>, key: &str) -> bool {
    limiter.check_key(&key.to_owned()).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_burst_then_refusal_per_key() {
        let l = Limits::default();
        for _ in 0..5 {
            assert!(allow(&l.password_email, "a@x.org"));
        }
        assert!(!allow(&l.password_email, "a@x.org"));
        assert!(allow(&l.password_email, "b@x.org"), "keys are independent");
    }
}

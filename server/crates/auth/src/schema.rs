//! Auth's tables in `platform.db`: its own append-only step list
//! ([`store::PlatformSchema`], versioned under `auth` in
//! `platform_schema`), run when the store opens, after the boot's
//! pre-migration copy (`api::schema::PLATFORM_SCHEMAS`). Never edit a
//! shipped step.
//!
//! `users` (id, email) and `memberships` belong to the platform list; auth
//! adds rows keyed by `users.id`.

use store::PlatformSchema;

pub const SCHEMA: PlatformSchema = PlatformSchema {
    name: "auth",
    steps: STEPS,
};

const STEPS: &[&str] = &[
    // 1: credentials, second factors, sessions, invites, resets, log.
    "CREATE TABLE auth_credentials (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        password_hash TEXT NOT NULL,
        second_factor TEXT CHECK (second_factor IN ('totp', 'email')),
        totp_secret TEXT,
        totp_last_step INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        CHECK ((second_factor = 'totp') = (totp_secret IS NOT NULL))
    ) STRICT;
    CREATE TABLE auth_recovery_codes (
        user_id INTEGER NOT NULL REFERENCES users(id),
        code_hash TEXT NOT NULL,
        used_at INTEGER,
        PRIMARY KEY (user_id, code_hash)
    ) STRICT;
    CREATE TABLE auth_sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        stage TEXT NOT NULL CHECK (stage IN ('second_factor', 'enrol', 'full')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        authenticated_at INTEGER,
        pending_secret TEXT,
        pending_secret_expires INTEGER,
        email_code_hash TEXT,
        email_code_expires INTEGER,
        email_code_attempts INTEGER NOT NULL DEFAULT 0,
        dev INTEGER NOT NULL DEFAULT 0 CHECK (dev IN (0, 1)),
        CHECK ((stage = 'full') = (authenticated_at IS NOT NULL))
    ) STRICT;
    CREATE INDEX auth_sessions_user ON auth_sessions (user_id);
    CREATE INDEX auth_sessions_expiry ON auth_sessions (expires_at);
    CREATE TABLE auth_invites (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        email TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'staff', 'viewer')),
        invited_by INTEGER REFERENCES users(id),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        accepted_at INTEGER,
        revoked_at INTEGER
    ) STRICT;
    CREATE INDEX auth_invites_tenant ON auth_invites (tenant_id, email);
    CREATE TABLE auth_resets (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
    ) STRICT;
    CREATE INDEX auth_resets_user ON auth_resets (user_id);
    CREATE TABLE auth_log (
        id INTEGER PRIMARY KEY,
        at INTEGER NOT NULL,
        event TEXT NOT NULL,
        user_id INTEGER,
        actor TEXT NOT NULL,
        tenant_id TEXT,
        detail TEXT NOT NULL DEFAULT ''
    ) STRICT;",
    // 2: the dev stub's session table (F1, base schema): auth_sessions
    // replaced it; nothing reads it.
    "DROP TABLE IF EXISTS sessions;",
    // 3: the S1 security review.
    // - M1: second-factor failures, per session and per user (the hourly
    //   lock), persisted so a deploy doesn't reset them.
    // - M5: the emailed code a sign-in needs once the per-email password
    //   limit is spent.
    // - M6: idle timeout (`last_seen`) and the sessions list (`user_agent`).
    // - M7: after a 2FA reset, enrolling needs an emailed code too.
    // - M2: codes are now HMAC under KEEP_AUTH_PEPPER and recovery codes
    //   longer. The old unpeppered SHA-256 rows can't be converted (no
    //   plaintext), so they go: dev data only, and an account keeps its
    //   factor (new recovery codes from Your account). Live emailed codes
    //   and pending enrolment secrets are voided the same way. Enrolled
    //   TOTP secrets are sealed by `auth::keys::seal_plaintext_secrets` at
    //   boot (it needs the key, which a SQL step can't have).
    "ALTER TABLE auth_credentials ADD COLUMN must_prove_email INTEGER NOT NULL DEFAULT 0
        CHECK (must_prove_email IN (0, 1));
    ALTER TABLE auth_sessions ADD COLUMN factor_failures INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE auth_sessions ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE auth_sessions ADD COLUMN user_agent TEXT;
    UPDATE auth_sessions SET last_seen = created_at;
    CREATE TABLE auth_factor_failures (
        user_id INTEGER NOT NULL REFERENCES users(id),
        at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX auth_factor_failures_user ON auth_factor_failures (user_id, at);
    CREATE TABLE auth_email_gates (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        code_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    DELETE FROM auth_recovery_codes;
    UPDATE auth_sessions SET email_code_hash = NULL, email_code_expires = NULL,
        email_code_attempts = 0, pending_secret = NULL, pending_secret_expires = NULL;",
];

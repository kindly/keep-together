# 0009 — Tooling

Status: **superseded by [0017](0017-convex-react-shared-tenancy.md)** (2026-10, mechanism; see 0017 for what survives) · in ngo-go was: accepted (2026-07) · revised alongside 0011 (JS toolchain removed)

## Decision

| Concern | Tool | Rationale |
|---|---|---|
| Python packaging | uv | fast, lockfile, no Docker needed for dev |
| Lint/format | ruff (check + format), covering `backend/` and `extensions/` | one tool |
| Types | mypy + django-stubs | best Django ORM inference |
| Tests | pytest + pytest-django | run twice in CI: stock and `NGO_EXTENSIONS=example` |
| Templating | Jinja (app UI) + Django engine (admin/allauth) | speed + maintainer preference; engines split by directory |
| CSS | Tailwind v4 **standalone binary** (`just tailwind-bin`) | modern look, zero node/npm; `just css` builds one file |
| Interactivity | htmx (vendored in `backend/static/js/`) | no build step, no CDN dependency |
| Task runner | just (`set tempdir := ".just"` for sandboxed sessions) | one discoverable command surface |
| Settings | pydantic-settings (`NGO_` prefix) | typed env vars, fails loudly at boot |
| Static files | whitenoise; manifest storage in production, plain in DEBUG | cache-busted assets, provider-agnostic |
| Server | uvicorn (ASGI), dev and prod | required by ADR 0004 |

## Consequences

- Dev environment is uv venv + local Postgres — **no Docker, no node**.
- Always drive tasks through `just` recipes so local and CI stay
  identical (`just check` = what CI runs).
- Pre-commit hooks deliberately omitted; CI is the gate.

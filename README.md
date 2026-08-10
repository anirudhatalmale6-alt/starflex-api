# STARFLEX API — Phase 2 (citizen platform)

Node.js + Express + PostgreSQL + JWT/OTP API for the STARFLEX national civic platform.
Front-end: https://anirudhatalmale6-alt.github.io/starflex/

## Endpoints
### Auth
- `POST /api/auth/register` — create citizen, sends OTP (email or phone)
- `POST /api/auth/verify-otp` — confirm code → JWT token
- `POST /api/auth/resend-otp`
- `POST /api/auth/login` — unverified accounts are re-sent an OTP
- `GET  /api/auth/me` · `PUT /api/auth/profile`

### Civic (JWT required unless noted)
- `GET  /api/civic/dashboard` — points, counts, certificate, recent activity
- `GET  /api/civic/modules` · `POST /api/civic/modules/:id/complete`
- `GET  /api/civic/consultations` · `POST /api/civic/consultations/:id/respond`
- `GET  /api/civic/consultations/:id/results` *(public)*
- `GET  /api/civic/volunteer` · `POST /api/civic/volunteer/:id/signup`
- `GET  /api/civic/notifications` · `PUT /api/civic/notifications/read`
- `GET  /api/civic/certificate/verify/:code` *(public)*
- `GET  /api/civic/posts` *(public — news/events)*

## Points & certificate
Every action writes to `point_events` (audit trail) and updates the citizen total.
Certificate levels derive from points: **bronze 30 · argent 75 · or 150**, issued and
upgraded automatically with a publicly verifiable code (`SF-00001-XXXXX`).

## Database
Lives in its own `starflex` PostgreSQL schema, so it is isolated from other apps on the
same instance and can be moved to a dedicated database with a single schema dump.

Apply schema + seed starter content:
```
DATABASE_URL=postgres://... npm run migrate
```

## OTP delivery
OTP generation, storage, expiry (10 min) and verification are complete. Until an
SMS/email provider is connected, codes are returned in the API response when
`EXPOSE_OTP=true` so the flow is testable end to end. Wire SendGrid/Twilio in
`src/routes/auth.js` → `issueOtp()`.

Powered by HaitiBiznis Technologies.

# Roadmap

## Done
- [x] Admin dashboard v1 (facts, moderation, taxonomy, players, daily, analytics)
- [x] Password reset link on sign-in gate
- [x] Add michael.anderson@trackdub.com to ADMIN_EMAIL_ALLOWLIST
- [x] Design-system audit fixes (namespace CSS vars, .dsignore styles.css, dep placement)
- [x] Role management screen (view users, grant/revoke admin custom claim)
- [x] MFA (TOTP) on the admin sign-in gate
- [x] Per-round accuracy analytics (signed round telemetry → `/admin/analytics`; PLAN.md slice 1)
- [x] Server-side dispute bounty settlement + callable-only reporting (PLAN.md slice 2, minus escalation)
- [x] Responsive admin navigation and mobile layouts for admin views (dense tables scroll within their panels)
- [x] Collapsible mobile navigation drawer with active states and close-on-navigation; compact mobile record cards retain row actions
- [x] Responsive non-admin routes and shared design-system components across phone, tablet, and desktop widths

## In progress
- [ ] Fix collapsing mobile fields and align admin button text, weight, clipping, and spacing
- [ ] Reporter overturn-rate escalation (`escalateHuman`) — PLAN.md item 7
- [ ] Aggregate ombudsman-vs-human agreement-% dashboard — PLAN.md item 8 remainder

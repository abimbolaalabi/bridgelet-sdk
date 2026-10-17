# Bridgelet SDK

**Backend SDK for ephemeral Stellar account management**

**MVP Stubs**

> 🚧 **The expiresIn → expiry_ledger conversion** — needs verification or explicit documentation of where it happens
> 🚧 **Webhook coverage gaps**

## Overview

The Bridgelet SDK is a NestJS-based backend service that manages the lifecycle of ephemeral Stellar accounts. It handles account creation, claim authentication, webhook notifications, and integration with the bridgelet-core smart contracts.

---

## ⚠️ TEMPORARY DEVELOPMENT WORKAROUNDS (IMPORTANT)

**PLEASE READ THIS SECTION BEFORE DEVELOPMENT**

The following services/imports are currently **commented out** to allow `npm run start:dev` to run without errors. These are **NOT removed** and **MUST be restored** once proper implementations exist.

### Missing Services:

1. **WebhooksService** (referenced in `src/modules/claims/providers/claim-redemption.provider.ts`)
   - **Location:** `src/modules/webhooks/` (does not exist yet)
   - **What was commented out:**
     - Constructor dependency injection (line ~25)
     - Webhook trigger for `sweep.completed` event (line ~106)
     - Webhook trigger for `sweep.failed` event (line ~137)
   - **Why:** Service implementation does not exist, causing TypeScript compilation errors
   - **Impact:** Webhook notifications will NOT fire when claims are redeemed or when sweeps fail
   - **Restoration required:** Once `WebhooksService` is implemented in `src/modules/webhooks/`, uncomment all marked sections

### How to Find Temporary Changes:

1. Search the codebase for comments containing `TEMPORARY:` to locate all commented-out code that needs restoration..

2. **Ledger Expiry Conversion** (resolved)
   - `CreateAccountDto.expiresIn` (seconds) is converted to the contract's `expiry_ledger`
     (u32) by `StellarService.toExpiryLedger()`:
     `current_ledger + ceil(expiresIn / 5) + EXPIRY_BUFFER_LEDGERS`
   - `expiresAt` (Date) is intentionally **not** passed to `StellarService`. Expiry
     responsibility is split as follows:
     - **Contract-side (authoritative):** `expiry_ledger` is set at `initialize()` and
       enforced on-chain (`AccountExpired` on late payment/sweep; `expire()` rejects
       with `NotExpired` before the ledger is reached).
     - **DB-side:** `expiresAt` is derived in `AccountsService` from the same
       `expiresIn` and drives the `SchedulerService` sweep, which finds due accounts,
       calls `StellarService.expireAccount()`, then marks them `EXPIRED`. It is also
       used by claim-token and API expiry checks.
     - Because the on-chain ledger includes a small buffer, the contract may expire
       slightly after `expiresAt`; `expireAccount()` skips if the expiry ledger has
       not yet been reached, and the scheduler retries on a later run.
3. **Sweep Authorization Signature** (`src/modules/sweeps/providers/contract.provider.ts`)
   - **Current:** `generateAuthSignature()` produces a fake 64-byte stub signature
   - **Works because:** `EphemeralAccount.verify_sweep_authorization()` in `bridgelet-core`
     is also a stub that accepts any signature (documented in bridgelet-core README)
   - **Impact:** Sweep authorization is not cryptographically enforced in development
   - **Guard:** Method throws if called outside `development` or `test` environments
   - **Required:** Real Ed25519 signing against the `SweepController`'s `authorized_signer`
     once `bridgelet-core` implements real verification.

### Status:

This is a **temporary stabilization** to enable local development and onboarding until missing implementations are complete. **No code was deleted** - all logic remains in place as comments.

---

## Security

Ephemeral Stellar secret keys are encrypted at rest with AES-256-GCM (KMS-backed envelope encryption in production). See [SECURITY.md](SECURITY.md) for the full encryption, key-management, and legacy-data-migration details.

## Tech Stack

- **Framework:** NestJS (Node.js + TypeScript)
- **Database:** PostgreSQL
- **ORM:** TypeORM
- **Blockchain:** Stellar SDK (`@stellar/stellar-sdk` pinned to exact version `17.2.1` for reproducibility) + Soroban RPC
- **API:** REST api

### Stellar SDK Version

`@stellar/stellar-sdk` is pinned to an **exact version** (`17.2.1`) in `package.json` — no caret or tilde range. Do not "fix" this into `^17.2.1` (issue #446, originally pinned in #213):

- The SDK exposes raw Stellar XDR and Soroban ScVal types. A minor or patch bump can change serialization behaviour — transaction building, `Address.toScVal().toXDR()` output, the sweep-authorization message preimage — and break contract calls in ways that only show up against a live network, not in unit tests.
- An exact pin makes the dependency tree reproducible across developer machines and CI without relying on the lockfile being regenerated in lockstep with `package.json`.
- A caret range does not just risk drift, it _hides_ it: `^17.2.1` silently admits `17.9.0`, so a routine `npm install` can change the bytes this service signs and submits without any commit touching the version.

**Upgrade process** (manual, by hand — nothing upgrades the pin for you):

1. Update the version in `package.json` to the new exact version.
2. Run `npm install` to update `package-lock.json`.
3. Run the full test suite: `npm test`.
4. Manually test account creation, claim/redemption, sweep and expiry flows against **testnet** before merging.
5. Only promote to production after all testnet checks pass.

**Automated check.** `npm run check:stellar-sdk-pin` fails if `@stellar/stellar-sdk` is declared as anything other than an exact version — a caret, tilde, comparison range, wildcard, dist-tag, partial version, or a missing/empty value. It runs as its own named step in [CI](.github/workflows/ci.yml) ("Verify @stellar/stellar-sdk is pinned to an exact version") so a PR that loosens the pin is rejected with an explanation rather than a bare lint warning.

**Upgrade notification.** [.github/workflows/stellar-sdk-update-notify.yml](.github/workflows/stellar-sdk-update-notify.yml) runs weekly, compares the pin against the version npm publishes as `latest`, and keeps a single tracking issue (label `dependency-update`) up to date. It never upgrades anything, cannot fail a build, and stays silent on the weeks when nothing has changed.

## Features

- Account lifecycle management (create, claim, expire)
- Claim authentication via signed tokens
- Webhook system for payment events
- Integration with bridgelet-core contracts
- Admin dashboard API endpoints

## Project Structure

```
src/
├── modules/
│   ├── accounts/        # Ephemeral account management
│   ├── claims/          # Claim authentication & processing
│   ├── sweeps/          # Fund sweep orchestration
│   ├── webhooks/        # Event notification system
│   └── stellar/         # Stellar/Soroban integration
├── common/
│   ├── guards/          # Auth guards
│   ├── interceptors/    # Logging, transform
│   └── filters/         # Exception filters
├── config/              # Environment configuration
└── database/            # Migrations, entities

scripts/
└── generate-migrations.sh  # Regenerates src/database/migrations/ from scratch
```

## Installation

```bash
# Install dependencies
npm install

# Setup environment
cp .env.example .env
# Edit .env with your configuration

# Run database migrations
# DataSource config : src/config/typeorm.config.ts
# Migrations        : src/database/migrations/
#   1718100000000-CreateAccountsTable              (accounts table, status enum, expiredAt, metadata)
#   1718100001000-CreateClaimsTable                (claims table + FK to accounts)
#   1718100002000-AddInitializingToAccountStatus   (adds INITIALIZING to account_status enum)
#   1718100003000-CreateWebhooksTable              (webhooks table)
#   1718100004000-AddClaimingToAccountStatus       (adds CLAIMING to account_status enum)
#   1718100005000-CreateWebhookDeliveriesTable     (webhook delivery attempt log table)
#   1718100006000-AddHighTrafficIndexes            (accounts composite and range indexes)
#   1718100007000-CreateContractEventsTable        (Soroban contract event index table)
#   1718100008000-AddDeletedAtToAccountsTable      (soft-delete column + index on accounts)
#   1718100008000-AddPartialSweepToAccountStatus   (adds PARTIAL_SWEEP to account_status enum)
#   1718100008000-CreateClaimAuditLogTable         (claim attempt audit log table)
npm run migration:run

# Start development server
npm run start:dev
```

### Regenerating the migrations folder

`src/database/migrations/` is scripted rather than hand-maintained. `scripts/generate-migrations.sh` deletes the folder and rewrites every file listed above verbatim, so the folder on disk is always reproducible from the script instead of relying on files someone created by hand.

```bash
# Recreate src/database/migrations/ from the script (prompts for confirmation)
./scripts/generate-migrations.sh

# Same, but skip the confirmation prompt (useful in CI)
./scripts/generate-migrations.sh --yes

# Skip the prompt AND overwrite uncommitted changes in the migrations folder
# (only needed when you deliberately want to discard hand-edited migrations)
./scripts/generate-migrations.sh --yes --force
```

Before deleting anything, the script runs a pre-flight `git status --porcelain` check
against `src/database/migrations/` and aborts if it finds uncommitted changes there
(modified, staged, or untracked files) — the rewrite would otherwise silently destroy
them. Commit or stash your migration work first, or pair `--yes` with `--force` to
overwrite deliberately.

This does **not** apply migrations to a database — it only (re)writes the `.ts` files. Run `npm run migration:run` afterwards as usual. See [`CONTRIBUTING.md`](./CONTRIBUTING.md#database-migrations) for the workflow to follow when adding a _new_ migration.

## Tests

```bash
npm test

## or to run specific tests
npm test -- test_Service_File_Name

## e.g
npm test -- sweeps.service.spec.ts
```

### Coverage

Run the full coverage report (enforces 80% minimum threshold):

```bash
npm run test:cov
```

Coverage reports are generated in the `coverage/` directory. The build will fail if any metric (branches, functions, lines, statements) falls below 80%.

The repository also includes an embedded-Postgres integration test in `test/migrations.integration.runner.ts` (`npm run test:migrations`) that starts a fresh PostgreSQL instance, applies all current migrations in their pinned filename order (a reordering fails the run), reports the entity ↔ schema diff and `account_status_enum` values, exercises the `claims.accountId -> accounts.id` and `webhook_deliveries.subscription_id -> webhooks.id` foreign keys, the high-traffic `accounts` indexes added by migration `1718100006000`, and the `contract_events` table shape, then reverts every migration to zero and re-applies them, failing the run if the round trip does not reproduce the original state. It is not part of `npm test` and must be run explicitly.

To check coverage for a specific file:

```bash
npm test -- sweeps.service.spec.ts --coverage
```

### Load testing and connection pool sizing

Each app instance opens at most **10** PostgreSQL connections (`POOL_CONFIG.max` in `src/config/database.config.ts`), and a caller that cannot get a connection within **3s** (`connectionTimeoutMillis`) fails fast rather than hanging.

When load testing (e.g. 50 concurrent `POST /accounts` requests against one instance), requests beyond the 10 in-flight queries queue in the pool. That is expected: each request holds a connection only briefly, so the queue drains well within the 3s timeout at this concurrency. If you see `timeout exceeded when trying to connect` under load, raise `max` or scale out instances. Don't set `max` so high that the total stops fitting on the server:

```
instances × POOL_CONFIG.max  +  migration/CLI pools  +  other services  <  Postgres max_connections (default 100)
```

See `docs/deployment.md` for multi-instance sizing guidance.

## Environment Variables

```env
# Database
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=bridgelet
DATABASE_USER=postgres
DATABASE_PASSWORD=postgres

# Stellar
STELLAR_NETWORK=testnet
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org

# Smart contracts
EPHEMERAL_ACCOUNT_CONTRACT_ID=CXXXX...   # shared ID; still used by payment monitor, sweeps and ContractProvider (NOT by account creation)
EPHEMERAL_ACCOUNT_WASM_HASH=<64 hex>      # required (except NODE_ENV=test): each account's own contract instance is deployed from this WASM hash
SWEEP_CONTROLLER_CONTRACT_ID=CXXXX...    # SweepController that authorizes sweeps; redeploys produce a NEW ID (see below)

# Security
JWT_SECRET=your-secret-key
CLAIM_TOKEN_EXPIRY=2592000  # 30 days

# Application
PORT=3000
NODE_ENV=development
CLAIM_BASE_URL=http://localhost:3000  # base URL for claim links (`<base>/c/<token>`); production must set its own https URL
```

> **Redeploying `SWEEP_CONTROLLER_CONTRACT_ID`.** Each ephemeral account is
> initialized with the controller ID in effect when it was created and stores it
> as the contract's `authorized_controller`. Changing this value therefore only
> points **new** accounts at the new controller — existing accounts stay bound to
> the controller they were created under and keep sweeping through it. A sweep
> submitted for an account against a controller it is not bound to is rejected
> on-chain; the SDK surfaces that as HTTP `502 SWEEP_CONTRACT_FAILED`.

## API Documentation

Once running, access API docs at:

- Swagger: `http://localhost:3000/api/docs`

## Key Endpoints

POST /accounts # Create ephemeral account (also returns the claim token)
GET /accounts/:id # Get account details
GET /accounts # List accounts (admin, paginated)
POST /claims/verify # Check a claim token is still valid
POST /claims/redeem # Redeem claim and sweep funds
GET /claims/:id # Get a recorded claim
GET /webhooks # List webhook subscriptions (active only, paginated)
POST /webhooks # Subscribe to events
PUT /webhooks/:id # Update webhook subscription (url, events, isActive, secret)
DELETE /webhooks/:id # Soft-delete (deactivate) a webhook subscription

Full request/response documentation: [API Reference](./docs/api-reference.md)

> There is no `POST /claims/initiate` endpoint. The claim token is minted by
> `POST /accounts` and returned once, in that response's `claimUrl`.

## Database Schema

See [Database Schema Documentation](./docs/database-schema.md)

## Development

```bash
# Run tests
npm run test

# Run e2e tests
npm run test:e2e

# Lint
npm run lint

# Format
npm run format
```

# Contributing

## Automated PR Naming Checks

All pull requests are validated automatically for branch naming and PR title format.

- During the initial rollout, checks run in warning mode until **2026-02-27**.
- After that date, pull requests are blocked until naming issues are fixed.

### Branch Name Format

Accepted pattern:

`(fix|feature|test|chore|docs)/issue-NUMBER-brief-description`

Regex used by CI:

`^(fix|feature|test|chore|docs)/issue-[0-9]+-[a-z0-9-]+$`

Examples:

- `fix/issue-42-jwt-error-handling`
- `feature/issue-50-webhook-service`

`main` and `develop` are exempt for release/hotfix workflows.

### PR Title Format

Accepted pattern:

`(Fix|Feature|Test|Chore|Docs): Brief description (#NUMBER)`

Regex used by CI:

`^(Fix|Feature|Test|Chore|Docs): .+ \(#[0-9]+\)$`

Examples:

- `Fix: Handle JWT errors in TokenVerificationProvider (#42)`
- `Test: Add unit tests for ClaimLookupProvider (#43)`

### How To Fix A Branch Name

Rename your local branch and push the new branch:

```bash
git branch -m fix/issue-42-jwt-error-handling
git push origin -u fix/issue-42-jwt-error-handling
```

Then update the PR to use the renamed branch. If needed, close the old PR and open a new one from the renamed branch.

### How To Fix A PR Title

Edit the PR title directly in GitHub:

1. Open the pull request.
2. Click the title field.
3. Update it to the required format.
4. Save changes.

## Deployment

See [Deployment Guide](./docs/deployment.md) for production setup, including a
step-by-step [Render deployment walkthrough](./docs/deployment.md#deploying-on-render-issue-824).

## Documentation

- [API Reference](./docs/api-reference.md)
- [Database Schema](./docs/database-schema.md)
- [Webhook Events](./docs/webhook-events.md)
- [Deployment Guide](./docs/deployment.md)

Visit http://localhost:3000/api/docs for API documentation.

See [Getting Started Guide](./docs/getting-started.md) for full setup instructions.

## Support

[NestJS](https://nestjs.com)

## License

UNLICENSED

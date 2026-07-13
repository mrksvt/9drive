# 9Drive Analysis

**Date:** 2026-07-13
**Focus:** Full analysis (structure, features, architecture, database, security, performance)

---

## 1. Overview
9Drive is a **storage gateway** web app for connecting multiple Google Drive accounts (and S3-compatible storage) into one virtual storage dashboard. Users can:
- Register/login with email/password or Google
- Auto-connect first Google Drive account during Google sign-in
- Connect additional Google Drive/S3 accounts
- Track combined quota
- Upload files (streamed through backend to Google Drive/S3)
- Organize files in virtual folders (app-only, not in Google Drive/S3)
- Preview/download/share files
- Sync MySQL file records from Google Drive/S3
- Invite other users to files/folders
- Route uploads to the connected account with enough free space
- Migrate files between Google Drive and S3

---

## 2. Domain Analysis

### 2.1. Auth & User
**DB Schema:**
- `User`: id, name, email, passwordHash, status
- `UserSession`: refreshTokenHash, expiresAt
- `AuthHandoff`: tokenHash (Google auth handoff)
- `ProviderConfig`: clientIdEncrypted, clientSecretEncrypted (Google OAuth global)
- `OauthState`: stateHash (CSRF protection)

**Backend:**
- `/auth/*`: register, login, refresh, logout, me
- `/connected-accounts/google/*`: connect, callback, exchange
- Google OAuth: auto-connect first account on sign-in
- JWT: access/refresh token, bearer auth
- reCAPTCHA: optional (email/password register)

**Frontend:**
- `LoginPage`, `RegisterPage`, `GoogleAuthPage`
- `SettingsPage`: connect/disconnect Google Drive
- `GoogleConnectedPage`: callback handler

**Flow:**
1. User register/login (email/password or Google)
2. If Google: auto-connect first Drive account
3. User can connect more accounts in Settings

**Security:**
- JWT access token (900s), refresh token (30d)
- Refresh token hashed in DB
- Google tokens encrypted in DB
- reCAPTCHA optional (email/password register)
- CSRF protection (OauthState)

**Risks:**
- Google OAuth scopes: `drive`, `userinfo.email`, `userinfo.profile` (full Drive access)
- reCAPTCHA bypassable if env empty
- JWT secret and encryption key in env (do not commit)

---

### 2.2. Storage & Quota
**DB Schema:**
- `ConnectedAccount`: provider, providerAccountId, accessTokenEncrypted, refreshTokenEncrypted, scopes
- `StorageAccount`: totalBytes, usedBytes, availableBytes, trashBytes, lastSyncedAt
- `S3StorageConfig`: bucket, region, endpoint, accessKeyIdEncrypted, secretAccessKeyEncrypted

**Backend:**
- `/connected-accounts/*`: connect, sync-quota, delete
- `/storage/summary`: quota summary (all accounts)
- `/storage/breakdown`: quota per account

**Frontend:**
- `QuotaTrackerPage`: quota summary + per account
- `SettingsPage`: connect/disconnect accounts

**Flow:**
1. User connects Google Drive/S3 account
2. Backend stores tokens encrypted
3. User manually syncs quota
4. Backend hits Google Drive API/S3 API → stores in `StorageAccount`

**Performance:**
- Quota sync: manual (bottleneck if many files)
- Google Drive API: rate limits (no retry/backoff in code)

**Risks:**
- Tokens encrypted but still vulnerable if env leaks
- Manual quota sync → users may forget → stale data

---

### 2.3. File & Folder
**DB Schema:**
- `File`: id, userId, connectedAccountId, folderId, provider, providerFileId, name, mimeType, sizeBytes, status, deletedAt
- `Folder`: id, userId, parentId, connectedAccountId, provider, providerFolderId, name, color, iconUrl, deletedAt
- `UploadSession`: fileName, mimeType, sizeBytes, status, targetConnectedAccountId

**Backend:**
- `/files/*`: list, get, patch, delete, batch, sync-google, preview-token, view-url, download
- `/folders/*`: list, create, patch, delete
- `/uploads`: multipart upload → stream to Google Drive/S3
- `POST /files/sync-google`: sync MySQL from Google Drive folder `9drive`

**Frontend:**
- `AllFilesPage`: list files/folders, upload, preview, download, rename, move, delete, share, invite
- `SharedPage`: list shared files/folders
- `PublicFilePage`: preview/download shared file

**Flow:**
1. User uploads file → backend selects account with enough quota → streams to Google Drive/S3
2. Files stored in Google Drive folder `9drive` or S3 prefix `9drive`
3. Virtual folders: MySQL-only (not in Google Drive/S3)
4. User manually syncs: `POST /files/sync-google` → backend scans `9drive` folder → updates MySQL

**Performance:**
- Upload/download: streaming → minimal memory
- Sync: scans `9drive` folder → slow if many files
- Preview/download: streaming from Google Drive/S3 → minimal memory

**Risks:**
- Virtual folders: not in Google Drive/S3 → lost if MySQL fails
- Manual sync → users may forget → stale data
- No retry for failed uploads

---

### 2.4. Sharing & Invite
**DB Schema:**
- `FileShare`: fileId, userId, token, tokenHash, enabled, expiresAt
- `WorkspaceInvite`: inviterId, inviteeEmail, targetType, targetId, role, status

**Backend:**
- `/files/:id/share`: create/delete share token
- `/invites`: list, create, delete
- `/public/files/:token`: preview/download shared file

**Frontend:**
- `AllFilesPage`: share/invite modal
- `SharedPage`: list shared files/folders
- `PublicFilePage`: preview/download shared file

**Flow:**
1. User shares file → backend generates token → stores in `FileShare`
2. User sends link to invitee
3. Invitee opens link → previews/downloads file

**Security:**
- Share token: hashed in DB
- Public token: accessible without auth
- ExpiresAt: not implemented in frontend

**Risks:**
- Share token: vulnerable if link leaks
- No password protection for share links

---

### 2.5. Migration (Google Drive ↔ S3)
**DB Schema:**
- `MigrationSession`: userId, sourceAccountId, targetAccountId, status, totalFiles, totalFolders, completedFiles, failedFiles, totalBytes, migratedBytes, cursor
- `MigrationItem`: migrationId, sourceFileId, sourceParentId, name, mimeType, sizeBytes, isFolder, status, targetFileId, targetFolderId
- `MigrationJob`: migrationId, type, status, payload, retryCount

**Backend:**
- `/migration/*`: start, status, cancel
- `scanner.service.ts`: scans source (Google Drive/S3)
- `file-migrator.ts`: transfers file
- `migration-queue.ts`: queues jobs

**Frontend:**
- `MigrationPage`: UI for start/status/cancel migration

**Flow:**
1. User selects source (Google Drive) and target (S3)
2. Backend scans source → stores in `MigrationItem`
3. Backend transfers files → updates `MigrationSession` and `MigrationItem`
4. Frontend polls status

**Performance:**
- Migration: async + queue → minimal memory
- Scan: slow if many files
- Transfer: streaming → minimal memory

**Risks:**
- No automatic rollback for failed migrations
- No automatic retry for failed files

---

### 2.6. API & Upload Routing
**DB Schema:**
- `ApiKey`: userId, name, keyPrefix, keyHash, scopes, status, lastUsedAt, expiresAt
- `UploadRoutingPolicy`: userId, mode (most_available, round_robin, priority), priorityAccountIds

**Backend:**
- `/api-keys`: create, list, revoke
- `/uploads`: multipart upload → selects account based on `UploadRoutingPolicy`
- `/public-api/uploads`: upload via API key

**Frontend:**
- `ApiManagementPage`: create/revoke API keys

**Flow:**
1. User creates API key → backend stores keyHash
2. User uploads via API key → backend verifies keyHash → selects account based on `UploadRoutingPolicy` → streams to Google Drive/S3

**Security:**
- API key: hashed in DB
- Scopes: not implemented in frontend

**Risks:**
- API key: vulnerable if leaked
- No retry for failed uploads

---

## 3. Architecture & Code Structure

### 3.1. Backend
- **Stack:** Express + TypeScript
- **Modular:** `modules/<domain>/<domain>.routes.ts`, `modules/<domain>/<domain>.service.ts`
- **ORM:** Prisma (migrations + client)
- **Streaming:** Busboy (upload), Undici (Google Drive download)
- **Env:** `config/env.ts` (Zod validation)

### 3.2. Frontend
- **Stack:** Vite + React + TypeScript
- **Routing:** React Router
- **UI:** Tailwind CSS, lucide-react
- **API:** `lib/api.ts` (axios wrapper)
- **Auth:** `lib/auth.ts` (local storage)

### 3.3. Docker
- **Services:** MySQL, backend, frontend (nginx)
- **Backend:** auto-migrate + seed Google OAuth config
- **Frontend:** build-time env (`VITE_API_URL`, `VITE_RECAPTCHA_SITE_KEY`)

---

## 4. Security & Risks

### 4.1. Security Measures
- **JWT:** access/refresh tokens
- **Token Encryption:** Google, S3, API keys
- **reCAPTCHA:** optional (email/password register)
- **CSRF Protection:** OauthState
- **CORS:** restricted by `FRONTEND_URL`

### 4.2. Risks
| Risk | Impact | Mitigation |
|------|--------|-------------|
| Google OAuth scopes (full Drive access) | Unauthorized access to all Drive files | Enforce minimal scopes, user education |
| reCAPTCHA bypassable | Spam registrations | Enforce reCAPTCHA (do not make optional) |
| JWT secret/encryption key in env | Token theft | Auto-rotate keys, do not commit env |
| Share token leakage | Unauthorized file access | Password protection, expiresAt |
| Manual quota sync | Stale data | Auto-sync (cron job) |
| No retry for failed uploads | Data loss | Implement retry/backoff |
| No rollback for failed migrations | Data corruption | Implement rollback |

---

## 5. Performance & Bottlenecks

### 5.1. Performance Optimizations
- **Upload/Download:** streaming → minimal memory
- **Migration:** async + queue → minimal memory

### 5.2. Bottlenecks
| Bottleneck | Impact | Mitigation |
|------------|--------|-------------|
| Manual quota sync | Stale data | Auto-sync (cron job) |
| Google Drive API rate limits | Failed requests | Retry/backoff |
| Slow sync (many files) | Poor UX | Pagination, background sync |
| No retry for failed uploads | Data loss | Implement retry |

---

## 6. Recommendations

### 6.1. Security
- Enforce reCAPTCHA (do not make optional)
- Add password protection for share links
- Auto-rotate JWT secret and encryption keys
- Enforce minimal Google OAuth scopes

### 6.2. Performance
- Auto-sync quota (cron job)
- Implement retry/backoff for Google Drive API
- Add retry for failed uploads/migrations
- Optimize sync with pagination

### 6.3. Features
- Backup virtual folders to Google Drive/S3
- Implement rollback for failed migrations
- Add expiresAt for share tokens
- Implement scopes for API keys

### 6.4. Code
- Add logging for debugging
- Write unit tests
- Document API (Swagger/OpenAPI)
- Add observability (metrics, tracing)

---

## 7. Verification Checklist
- [x] No placeholders (all sections complete)
- [x] No contradictions (consistent across domains)
- [x] Scope appropriate (covers all domains)
- [x] No ambiguity (clear recommendations)

---

**Approval:** Ready for review.
# Skills/Agent repository storage

Repository bytes live in the private Cloudflare R2 bucket `koinote-agent-repositories`, bound as `AGENT_REPOSITORIES`. This covers current files, retained history, public snapshots, GitHub imports and Forks. PostgreSQL stores repository metadata, ownership, paths, revisions, SHA-256, lengths, object references and logical quotas. Documents and encrypted development-configuration snapshots are outside this change.

The Go backend verifies the account or current public publication before reading an object through the Worker's internal API. Object keys and the shared internal credential never reach clients. Do not enable public `r2.dev` access, custom public domains, or lifecycle deletion on this bucket. The existing public image/download buckets must not be reused. Public repository withdrawal remains immediate at the API boundary; previously downloaded copies remain with their recipients.

## Configuration and rollout

- Worker: both default and `production` environments bind `AGENT_REPOSITORIES` in `wrangler.jsonc`.
- Backend: `AGENT_REPOSITORY_STORAGE=r2` (default), `WORKER_URL` and `BACKEND_INTERNAL_TOKEN`. The same internal token must be configured in the Worker. Production rejects database mode, missing credentials and non-HTTPS Worker URLs at startup. For isolated local development only, explicitly use `AGENT_REPOSITORY_STORAGE=database` with a non-production environment.
- Deploy creates the private bucket if needed before restarting the backend, then publishes the Worker and verifies authenticated R2 access from the backend container. Existing backends remain compatible with the new Worker. On the first rollout, repository uploads may temporarily return 503 between backend startup and Worker deployment; they never silently store bytes in PostgreSQL. Deploying this storage-capable Worker first avoids that interval when coordinating a manual rollout.
- Health endpoint: authenticated `GET /api/internal/agent-repository-objects/health` returns 204 only when the bucket can be accessed. Authentication failures, missing bindings or bucket failures fail deployment verification. `/health` alone does not verify repository storage.
- Client APIs are unchanged, so existing web and desktop clients work. Import the curated 100 repositories only after the R2 health check succeeds. Platform-funded logical capacity remains separate from personal allocations. Administrators with a positive system storage grant receive 100 additional repository slots (200 total); ordinary accounts remain limited to 100.

## Writes, migration and integrity

Uploads are registered in the database before sending bounded, checksum-verified immutable objects to R2. All upload network I/O finishes before repository/account write locks. A later revision or quota conflict rolls back the file change and leaves a tracked staging object for cleanup. R2 failure returns a storage error and preserves the current revision; no database fallback is performed.

Migration 0086 enables R2 references without deleting legacy content. A restartable background job reads one legacy blob at a time, uploads it, reads it back and verifies SHA-256, then atomically replaces the blob's bytes with its R2 reference and clears duplicate current-file bytes. It retains the original content after upload, read-back or transaction failure. Migration preserves file hashes, histories, public revisions and quotas. Legacy reads remain available during migration; a failed blob is logged and retried. Migration does not execute repository files.

Full reads verify SHA-256. MCP range reads fetch only the requested range from R2 and retain the existing client hash/revision checks. Publication content scanning still caches results by verified hash and policy. Restore scans an immutable historical revision outside account locks, then rechecks the selected repository, current revision and retained historical revision in the mutation transaction.

Monitor completion using metadata-only queries:

```sql
SELECT count(*) AS legacy_blobs FROM agent_workspace_blobs WHERE content IS NOT NULL;
SELECT count(*) AS legacy_current_files FROM agent_workspace_files WHERE content IS NOT NULL;
SELECT count(*) AS r2_blobs FROM agent_workspace_blobs WHERE r2_object_key IS NOT NULL;
```

Both legacy counts should reach zero. PostgreSQL's ordinary vacuum reclaims dead tuples for reuse; this migration does not force a blocking table rewrite to shrink database files. Do not roll back to an application version that assumes non-null database content after migration begins. Restore a compatible application and database backup together if recovery is needed.

## Forks, cleanup and backups

Forks keep their own blob references to immutable objects; deleting a source repository or account cannot invalidate another repository's files. Logical quotas still charge each repository as before, independently of physical object sharing.

Uncommitted uploads expire after a short grace period (five minutes after a completed or failed attempt; one day after a crash). Cleanup locks the object reservation, rechecks references and deletes R2 before removing its database record; failures remain retryable. Referenced objects are never collected.

The existing database backup policy retains backups for up to 400 days. A committed object is therefore retained until at least 401 days after its last blob-reference change/removal, even when no live repository uses it. This allows an older metadata backup to restore its object references. These retained physical bytes do not consume the user's logical allocation, but do incur platform R2 storage. Changing backup retention requires adjusting this window together. Keep the private bucket intact when restoring database backups; database dumps alone no longer contain migrated repository files.

## Verification

`npm run test:agent-repository-storage` exercises authentication, body bounds, SHA-256, immutable retries, empty/5 MiB objects and ranges against Workerd's local R2 implementation. Real PostgreSQL tests cover failed-upload rollback, verified migration, cleanup retries, backup retention, publication revocation, Fork independence, GitHub provenance and MCP reads/writes/restores in both database and R2 modes. The opt-in curated-catalog integration uses reviewed archives and an HTTP object-store fixture, verifies all downloaded hashes and checks that no repository payload remains in PostgreSQL. These local checks do not claim a production R2 deployment.

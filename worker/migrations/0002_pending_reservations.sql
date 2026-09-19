-- worker/migrations/0002_pending_reservations.sql
-- Additive migration: reserve quota at share-create time so the cap cannot be
-- bypassed by never confirming an upload. A ledger row is inserted at create
-- with pending_expires_at set (short TTL); confirmShare clears it (NULL =
-- confirmed/counted). currentUsage counts confirmed rows plus pending rows that
-- have not yet passed pending_expires_at. Retention reclaims pending rows past
-- their pending_expires_at.
ALTER TABLE quota_ledger ADD COLUMN pending_expires_at INTEGER;
CREATE INDEX idx_ledger_pending ON quota_ledger(pending_expires_at);

-- Store challenge requester dimension: the challenge endpoint is anonymous and
-- the target address is self-reported, so an address-only quota lets anyone
-- lock out an arbitrary victim address by filling its quota. requester_key
-- records the issuing requester (peer address; empty string when the transport
-- does not expose one) so the quota can also bound each requester across all
-- addresses. System not launched: no legacy rows to backfill beyond the
-- shared empty-string bucket.
ALTER TABLE store_auth_challenge ADD COLUMN requester_key TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS store_auth_challenge_requester_idx
  ON store_auth_challenge (requester_key, issued_at);

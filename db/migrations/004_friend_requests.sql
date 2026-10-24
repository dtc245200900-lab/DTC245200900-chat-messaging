CREATE TABLE IF NOT EXISTS friend_requests (
  id BIGSERIAL PRIMARY KEY,
  sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (sender_id <> recipient_id),
  UNIQUE (sender_id, recipient_id)
);

CREATE INDEX IF NOT EXISTS idx_friend_requests_recipient
  ON friend_requests(recipient_id, created_at DESC);

INSERT INTO contacts(owner_id, contact_id)
SELECT contact_id, owner_id FROM contacts
ON CONFLICT DO NOTHING;

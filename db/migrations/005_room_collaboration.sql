CREATE TABLE IF NOT EXISTS room_favorites (
  room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS pinned_messages (
  room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (room_id, message_id)
);

CREATE TABLE IF NOT EXISTS room_tasks (
  id BIGSERIAL PRIMARY KEY,
  room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  title VARCHAR(160) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  assigned_to BIGINT REFERENCES users(id) ON DELETE SET NULL,
  due_at DATE,
  status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done')),
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS room_notes (
  room_id BIGINT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  body TEXT NOT NULL DEFAULT '',
  updated_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS room_events (
  id BIGSERIAL PRIMARY KEY,
  room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  title VARCHAR(160) NOT NULL,
  details VARCHAR(500) NOT NULL DEFAULT '',
  starts_at TIMESTAMPTZ NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_room_tasks_room_status ON room_tasks(room_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_room_events_room_start ON room_events(room_id, starts_at);

SET ROLE chat_runtime;

CREATE TABLE users(
  id BIGSERIAL PRIMARY KEY,
  username VARCHAR(32) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name VARCHAR(60),
  department VARCHAR(80) NOT NULL DEFAULT '',
  job_title VARCHAR(80) NOT NULL DEFAULT '',
  bio VARCHAR(280) NOT NULL DEFAULT '',
  avatar_data BYTEA,
  avatar_content_type VARCHAR(30),
  CONSTRAINT users_avatar_type_check CHECK (
    (avatar_data IS NULL AND avatar_content_type IS NULL)
    OR (
      avatar_data IS NOT NULL
      AND avatar_content_type IN ('image/jpeg', 'image/png', 'image/webp')
      AND octet_length(avatar_data) BETWEEN 1 AND 524288
    )
  )
);
CREATE TABLE rooms(
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(80) UNIQUE NOT NULL,
  description VARCHAR(240) NOT NULL DEFAULT '',
  is_public BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT REFERENCES users(id)
);
CREATE TABLE room_members(
  room_id BIGINT REFERENCES rooms(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(room_id,user_id)
);
CREATE TABLE messages(
  id BIGSERIAL PRIMARY KEY,
  room_id BIGINT REFERENCES rooms(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  body VARCHAR(2000) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE contacts(
  owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(owner_id,contact_id),
  CHECK(owner_id <> contact_id)
);
CREATE TABLE files(
  id BIGSERIAL PRIMARY KEY,
  room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  uploaded_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_name VARCHAR(255) NOT NULL,
  content_type VARCHAR(120) NOT NULL,
  content BYTEA NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 104857600),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE friend_requests(
  id BIGSERIAL PRIMARY KEY,
  sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(sender_id <> recipient_id),
  UNIQUE(sender_id,recipient_id)
);
CREATE TABLE room_favorites(
  room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(room_id,user_id)
);
CREATE TABLE message_reactions(
  message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(message_id,user_id,emoji)
);
CREATE TABLE pinned_messages(
  room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(room_id,message_id)
);
CREATE TABLE room_tasks(
  id BIGSERIAL PRIMARY KEY,
  room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  title VARCHAR(160) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  assigned_to BIGINT REFERENCES users(id) ON DELETE SET NULL,
  due_at DATE,
  status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','done')),
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE room_notes(
  room_id BIGINT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  body TEXT NOT NULL DEFAULT '',
  updated_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE room_events(
  id BIGSERIAL PRIMARY KEY,
  room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  title VARCHAR(160) NOT NULL,
  details VARCHAR(500) NOT NULL DEFAULT '',
  starts_at TIMESTAMPTZ NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_messages_room ON messages(room_id,created_at DESC);
CREATE INDEX idx_contacts_contact ON contacts(contact_id);
CREATE INDEX idx_files_room_created ON files(room_id,created_at DESC);
CREATE INDEX idx_friend_requests_recipient ON friend_requests(recipient_id,created_at DESC);
CREATE INDEX idx_room_tasks_room_status ON room_tasks(room_id,status,due_at);
CREATE INDEX idx_room_events_room_start ON room_events(room_id,starts_at);

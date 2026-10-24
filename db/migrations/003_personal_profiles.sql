ALTER TABLE users ADD COLUMN IF NOT EXISTS department VARCHAR(80) NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title VARCHAR(80) NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio VARCHAR(280) NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_data BYTEA;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_content_type VARCHAR(30);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_avatar_type_check'
      AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_avatar_type_check CHECK (
        (avatar_data IS NULL AND avatar_content_type IS NULL)
        OR (
          avatar_data IS NOT NULL
          AND avatar_content_type IN ('image/jpeg', 'image/png', 'image/webp')
          AND octet_length(avatar_data) BETWEEN 1 AND 524288
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'files'::regclass
      AND conname = 'files_content_check'
      AND pg_get_constraintdef(oid) LIKE '%5242880%'
  ) THEN
    ALTER TABLE files DROP CONSTRAINT files_content_check;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'files'::regclass
      AND conname = 'files_content_check'
  ) THEN
    ALTER TABLE files
      ADD CONSTRAINT files_content_check
      CHECK (octet_length(content) BETWEEN 1 AND 104857600);
  END IF;
END
$$;

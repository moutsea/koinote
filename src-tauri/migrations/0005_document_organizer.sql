ALTER TABLE offline_folders
  ADD COLUMN organizer_kind TEXT
  CHECK (organizer_kind IS NULL OR organizer_kind IN ('smart', 'activity'));

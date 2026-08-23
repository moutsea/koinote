UPDATE user_feedback
SET page_path = '/share/:token'
WHERE page_path LIKE '/share/%'
  AND page_path <> '/share/:token';

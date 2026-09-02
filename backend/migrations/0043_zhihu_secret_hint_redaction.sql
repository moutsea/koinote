UPDATE zhihu_accounts
SET app_secret_hint = 'configured'
WHERE app_secret_hint <> 'configured';

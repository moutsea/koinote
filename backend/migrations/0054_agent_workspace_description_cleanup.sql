UPDATE agent_workspaces
SET description = ''
WHERE description IN (
    '可选，用于区分不同配置',
    'Optional, to distinguish configurations',
    'Facultatif, pour distinguer les configurations',
    '任意。設定の区別に使います'
);

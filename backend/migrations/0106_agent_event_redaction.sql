-- Older conversation workers kept the original payload when decoding failed.
-- Keep canonical audit/progress records. Replace noncanonical rows with the
-- same marker used by the worker, preserving their sequence and cursor.
UPDATE writing_agent_events e SET event='{"type":"unknown"}'
FROM writing_agent_tasks t
WHERE t.id=e.task_id AND t.conversation_task AND (
 jsonb_typeof(e.event) <> 'object' OR EXISTS (
  SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(e.event)='object' THEN e.event ELSE '{}' END) field
  WHERE NOT CASE
   WHEN field.key IN ('type','currentMessageId','decision','taskId','phase','model','provider','channelId','outcome','digest','toolName')
     THEN jsonb_typeof(field.value)='string'
   WHEN field.key IN ('version','inputVersion') THEN jsonb_typeof(field.value)='number'
   WHEN field.key='sourceMessageIds' AND jsonb_typeof(field.value)='array'
     THEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(field.value) item WHERE jsonb_typeof(item)<>'string')
   WHEN field.key='toolCall' AND jsonb_typeof(field.value)='object'
     THEN field.value - 'name' = '{}' AND jsonb_typeof(field.value->'name')='string'
   WHEN field.key='effects' AND jsonb_typeof(field.value)='array'
     THEN NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(field.value) item
       WHERE CASE WHEN jsonb_typeof(item)='object' THEN
         item - ARRAY['resourceId','kind','revision'] <> '{}' OR EXISTS (
          SELECT 1 FROM jsonb_each(item) attr WHERE jsonb_typeof(attr.value)<>'string'
         )
       ELSE true END
     )
   ELSE false END
 )
);

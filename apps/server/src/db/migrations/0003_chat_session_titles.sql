-- chat sessions get user-facing titles (null = derive label from created_at)
ALTER TABLE chat_sessions ADD COLUMN title TEXT;

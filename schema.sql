PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY,name TEXT NOT NULL,youtube_channel_id TEXT,niche TEXT DEFAULT '',default_language TEXT DEFAULT 'en',active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL,topic TEXT NOT NULL,language TEXT NOT NULL DEFAULT 'en',format TEXT NOT NULL DEFAULT 'short',target_minutes INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'queued',title TEXT,description TEXT,script TEXT,tags TEXT,thumbnail_key TEXT,media_key TEXT,youtube_video_id TEXT,youtube_url TEXT,error TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(channel_id) REFERENCES channels(id));
CREATE TABLE IF NOT EXISTS oauth_states(state TEXT PRIMARY KEY,channel_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS channel_tokens(channel_id TEXT PRIMARY KEY,refresh_cipher TEXT NOT NULL,refresh_iv TEXT NOT NULL,scope TEXT,token_updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(channel_id) REFERENCES channels(id));
CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT,action TEXT NOT NULL,details TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_channel_idx ON jobs(channel_id);

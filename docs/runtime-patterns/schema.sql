-- REFERENCE SCHEMA — extracted from n8nconverter/migrations/0001_automation_engine.sql
--
-- D1 schema for the automation engine runtime.
-- Tracks workflow executions and leads across tenants.

-- Workflow execution tracking
CREATE TABLE IF NOT EXISTS workflow_executions (
  id TEXT PRIMARY KEY,
  workflow_name TEXT NOT NULL,
  source TEXT,                      -- 'voice-platform', 'api', 'sequence-scheduler', etc.
  tenant_id TEXT,
  status TEXT CHECK(status IN ('running', 'completed', 'failed')) NOT NULL,
  result_json TEXT,
  error_message TEXT,
  execution_time_ms INTEGER,
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_executions_status ON workflow_executions(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_executions_tenant ON workflow_executions(tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_executions_source ON workflow_executions(source, started_at DESC);

-- Leads table (for lead.create function in function registry)
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  notes TEXT,
  source TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_leads_tenant ON leads(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);

Universal Tracker AI – Data Model Reference

This file tracks incremental data model additions and their intent. It is reference-only; use it to align client and backend changes.

Base item (existing)
- id: string
- title: string
- url: string
- status: 'todo' | 'done'
- category: string (one of existing categories)
- priority: 'low' | 'medium' | 'high'
- tags: string[]
- notes: string
- source: string (site/domain)
- reminder_time?: ISO string
- created_at: ISO string
- updated_at: ISO string

Additions (Phase 1)
- time_to_consume_mins?: number
  - Purpose: quick estimate for how long the item takes to consume.
  - Population: computed on Save/Edit using heuristics; optional AI later.
  - Sync: sent with item payloads; backend may store in a column or ignore.

Planned (Deferred enrichment, future phases)
- props?: object
  - author_or_channel?: string
  - publish_date_iso?: ISO string
  - series_or_franchise?: string
  - people?: string[]
  - streaming_availability?: string
  - genre?: string
- ai_meta?: object
  - confidence?: { category?: number; tags?: number; summary?: number; time?: number }
  - rationales?: { category?: string; tags?: string; summary?: string; reminder?: string }
  - model?: string
  - generated_at?: ISO string
  - schema_version?: number (start at 1)

Notes
- Client should not overwrite user-modified fields.
- Backend should gracefully ignore unknown keys; if unavailable, store JSON blobs (`props_json`, `ai_meta_json`).


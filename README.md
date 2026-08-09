# reading-tracker

A single-user reading and study tracker. Plain HTML, CSS and ES modules — no build
step, no framework, no dependencies, and no third-party scripts of any kind.

This repository holds only the application shell. All data lives in a separate
private repository and is fetched at runtime through the GitHub Contents API using
a fine-grained token supplied by the user, so the published page contains nothing
personal. A visitor without a token sees a prompt and nothing else.

## Phase 1 scope

Data layer, GitHub sync (UTF-8 base64 and conflict handling), text CRUD, queue
view, triage view, quick-log, and JSON export/import. Scoring, subjects, projects
and integrations are later phases; the schema already carries their fields.

## Editing

Change a file, commit, done. There is nothing to install and nothing to run.

## Token

Create a fine-grained personal access token scoped to the data repository only,
with `Contents: Read and write` and no other permission. Paste it into the app's
settings screen. It is stored in `localStorage` on that device and is never
committed here.

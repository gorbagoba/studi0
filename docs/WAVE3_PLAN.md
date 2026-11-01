# Wave plan — sidebar organisation + context menus (2026-11-01, queued behind WAVE2)

## Settled decisions (grill complete)
- One level of **groups** (MATH → modules), stored in the app DB (groups table + subjects.group_id, nullable = ungrouped); folders on disk untouched
- **Menus**: right-click AND kebab button, same actions; sidebar (subjects + groups) and Material file browser (material/ files only)
- Subject menu: Open · Rename (existing PATCH /api/subjects/:id — wire the UI) · Move to group ▸ · Merge into subject… · Remove from studi0 (files kept, typed confirm) · **Delete files from disk** (type-subject-name confirm, refused while a job runs)
- Group menu: Rename · Delete (populated → "N subjects become ungrouped" confirm; never deletes subjects)
- File menu: Open · Rename · Delete (plain confirm) · **Move to subject…** — collisions skipped + reported; DB file rows re-pointed
- New group button; empty groups stay visible; ungrouped subjects list directly under the groups

## Tasks
- T-S1 backend: groups table migration + CRUD routes (create/rename/delete group; PATCH subject groupId) + move-file-between-subjects endpoint (re-point file row, move file on disk into target material/, collision skip+report) + delete-files-from-disk endpoint (refuse if active job). Contract addendum.
- T-S2 web: Sidebar groups (collapse/expand, new/rename/delete/move-to-group), ContextMenu component (right-click + kebab), subject/group menus with the confirm ladder.
- T-S3 web: FileBrowser context menus (material/ only), merge-into-subject flow with collision report.
- T-S4 security re-check (new destructive endpoints: disk-delete, file moves) + gates + QA.

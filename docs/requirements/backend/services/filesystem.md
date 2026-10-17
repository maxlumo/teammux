# Filesystem Service

## Purpose
Server-side filesystem operations. File: `src-tauri/src/fs.rs`

## Operations
- `resolve(path)` / `resolve_path(path)` — resolve path, handles `~` expansion
- `get_cwd(session)` — get session working directory (delegates to `tmux::pane_cwd`); an empty session or a session that can't report a path falls back to the server's home directory
- `list_dir(path, show_hidden)` — list directory entries with name, is_dir, size, modified, mime_hint, is_text
- `stat_file(path)` — file metadata (name, size, modified, permissions, mime_hint, is_text, is_dir)
- `read_file(path)` — read text file (≤512KB limit)
- `write_file(path, content)` — write text file
- `create_dir(path)` — create directory (recursive)
- `delete_path(path)` — delete file or directory (recursive for dirs)
- `rename_path(from, to)` — rename/move
- `download_file(path)` — read file into memory + base64 encode (≤50MB `MAX_READ_SIZE`), returns `(filename, data)`. Used for inline PDF/image preview. User-initiated file downloads go through the streaming HTTP `/dl` endpoint instead (no size limit, no base64 overhead); see `docs/design-docs/features/file-handling.md`.
- `upload_file(path, data_b64)` — upload from base64, creates parent dirs

## Helpers
- `mime_hint(name)` — infer MIME type from file extension (supports ~45 extensions, incl. `video/*` for mp4/m4v/webm/mov/mkv/ogv and `audio/*` for mp3/m4a/aac/ogg/oga/opus/wav/flac/weba, via the shared `streamed_media_type`)
- `is_text_file(path, name)` — heuristic: check extension + sample first 8KB for binary bytes
- `format_permissions(mode)` — Unix permission string (rwxrwxrwx)

## Security
- `sanitize_filename()` in `lib.rs` for download path traversal prevention (uses `Path::file_name()`)
- Full filesystem access is intentional (remote management tool)

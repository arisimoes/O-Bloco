<!-- Auto-generated: update with repo specifics if you add files -->
# Copilot instructions for this repository
<!-- Copilot instructions — tailored to this repo -->

# Quick orientation

- Language/runtime: Node.js + Electron. Entrypoint: `src/main.js` (Electron main). Renderer: `src/renderer.js` and `src/index.html`.
- Run locally: install deps then start Electron via `npm start` (see `package.json` -> `scripts.start`).

# Big picture (what to know fast)

- App purpose: Windows Electron client that syncs notes with Google Keep/Drive using Google OAuth and Drive `appDataFolder`.
- Data flow: Renderer UI (`renderer.js`) invokes `ipcRenderer` -> `ipcMain` handlers in `src/main.js`. `main.js` talks to Google APIs (via `googleapis`) and reads/writes files to Drive (notes stored as `.knote` zip packages; a `metadata.json` is kept in `appDataFolder`).
- OAuth: `credentials.json` and `token.json` live at project root. OAuth callback: `http://localhost:3000/oauth2callback` (port 3000). See constants in `src/main.js`.

# Critical files to inspect/edit

- `src/main.js`: core logic — OAuth flow, Drive interactions, `fetchNotes()`, zip handling (`adm-zip`), encoding detection (`jschardet` + `iconv-lite`), and IPC channels (`start-auth`, `list-notes`, `create-note`, etc.).
- `src/renderer.js`: UI event handlers and IPC usage; normalization rules for note names (removes `0001 - ` prefixes and file extensions).
- `src/index.html`: simple UI layout and element IDs referenced by `renderer.js`.
- `package.json`: run scripts and dependency list (notable packages: `googleapis`, `express`, `adm-zip`, `jschardet`, `iconv-lite`, `electron`).

# Developer workflow (how to run and debug)

- Install and start:

```bash
npm install
npm start
```

- OAuth setup: enable Keep/Drive APIs in Google Cloud Console, create OAuth credentials (desktop/web), download JSON and place as `credentials.json` at project root or use the in-app file picker (the app will copy it to the root).
- Tokens: after consent the app writes `token.json` at project root. For testing, remove `token.json` to force a new auth flow.

# Project-specific patterns & gotchas

- Notes storage: Notes may be plain text or `.knote` ZIP packages containing `note.txt` + `attachments/`. `main.js` treats names ending with `.knote`/`.zip` as ZIPs.
- Encoding handling: text decoding uses `jschardet` to detect encoding and `iconv-lite` to decode buffers — preserve this approach when modifying text import/export.
- Metadata: `metadata.json` stored in Drive's `appDataFolder` with fields like `lastId` and `items`. Use `getOrCreateMetadata()` and `writeMetadata()` helpers in `src/main.js`.
- UI-to-backend channels: prefer existing IPC names (e.g., `start-auth`, `list-notes`, `create-note`, `update-note`, `delete-note`, `open-file-dialog`) to keep renderer logic unchanged.

# Integration & dependencies

- External services: Google OAuth + Drive APIs via `googleapis`. The app expects network access during auth and Drive operations.
- Local files: `credentials.json`, `token.json` stored unencrypted in project root (development only). `token.json` removal triggers re-auth.

# When to ask the maintainer

- Any change requiring Google Cloud credentials, new scopes, or redirect-uri changes.
- Adding persistent storage beyond the repo root (secure storage, production secrets).

# Quick checks an AI agent should run

- Verify `package.json` scripts and dependency versions before suggesting installs or upgrades.
- Search `src/main.js` for new/modified IPC handlers if changing functionality that affects UI.

---

If you'd like, I can now (a) tighten this further to include exact code pointers and line links, or (b) open a PR with these changes. Feedback? 

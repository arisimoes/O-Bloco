# Keep Notes — Electron (Windows)

Minimal Windows Electron client that syncs notes with Google Keep and stores them in Drive's `appDataFolder`.

Quick start

```bash
npm install
npm start
```

OAuth setup

- Enable the Keep/Drive APIs in Google Cloud Console.
- Create OAuth 2.0 credentials (Desktop or Web) and add the redirect URI:

```
http://localhost:3000/oauth2callback
```
- Place the downloaded `credentials.json` at the project root or let the app ask you to select it via the UI (it will copy the file).

How the app works (big picture)

- Renderer (`src/renderer.js`) drives the UI and sends requests to the main process via IPC (`start-auth`, `list-notes`, `create-note`, `update-note`, `delete-note`, etc.).
- Main (`src/main.js`) handles OAuth (via `googleapis`), reads/writes note files to Drive `appDataFolder`, and stores a `metadata.json` inside a `notes` folder.
- Notes can be plain `.txt` or `.knote` (ZIP with `note.txt` + `attachments/`). Encoding detection uses `jschardet` + `iconv-lite`.

Creating a release (Windows executable / installer)

This repository includes an Electron Builder configuration and a GitHub Actions workflow to build Windows releases from tags.

- Local build (requires npm and a Windows environment or Wine):

```bash
npm ci
npm run dist
```

- Automated GitHub build: create a tag like `v0.1.0` and push it. The workflow `.github/workflows/release.yml` runs on tag push, builds the Windows artifacts and attaches them to the GitHub Release.

Notes about releases and credentials

- Build artifacts appear under `dist/` locally and are uploaded to the GitHub Release by the workflow. The built installer may require signing if you plan to distribute widely.
- OAuth `credentials.json` and `token.json` are stored unencrypted at repo root for development only — DO NOT commit production credentials.

Files to inspect when changing behavior

- `src/main.js` — OAuth flow, Drive interactions, `fetchNotes()` and metadata handling.
- `src/renderer.js` — UI logic, modal editor, and IPC usage.
- `src/index.html` — element IDs referenced by renderer.
- `package.json` — scripts and `build` config for `electron-builder`.

If you want, I can:
- add code links to exact lines in `src/main.js`/`renderer.js` to document important handlers;
- test a local build here (if you allow running npm on this machine) or help you run the GitHub Actions workflow by creating and pushing a tag.

Feedback? Diga se quer que eu crie a tag de release de exemplo ou rode um build local.

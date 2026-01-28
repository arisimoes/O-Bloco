const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const express = require('express');
const { google } = require('googleapis');
const AdmZip = require('adm-zip');
const iconv = require('iconv-lite');
const jschardet = require('jschardet');

let mainWindow;
let oauth2Client;

function decodeBuffer(buf) {
  if (!buf) return '';
  const result = jschardet.detect(buf);
  // jschardet might return things like 'windows-1252' or 'UTF-16LE'
  const encoding = result.encoding || 'utf8';
  try {
    return iconv.decode(buf, encoding);
  } catch (e) {
    return buf.toString('utf8');
  }
}

const CREDENTIALS_FILE = path.join(process.cwd(), 'credentials.json');
const TOKEN_FILE = path.join(process.cwd(), 'token.json');
const OAUTH_PORT = 3000;
const OAUTH_CALLBACK = `http://localhost:${OAUTH_PORT}/oauth2callback`;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  buildMenu();
}

function buildMenu() {
  // Load locale strings based on OS locale (fallback to English)
  let lang = (app.getLocale && typeof app.getLocale === 'function') ? app.getLocale() : 'en';
  lang = (lang || 'en').split('-')[0];
  let strings = { menu: { file: 'File', createNote: 'Create Note', open: 'Open...', save: 'Save', saveAs: 'Save As...', quit: 'Quit' } };
  try {
    const localePath = path.join(__dirname, '..', 'locales', `${lang}.json`);
    if (fs.existsSync(localePath)) {
      const content = fs.readFileSync(localePath, 'utf8');
      const parsed = JSON.parse(content);
      if (parsed && parsed.menu) strings = parsed;
    }
  } catch (e) {
    console.error('Failed to load locale, falling back to en:', e.message);
  }

  const template = [
    {
      label: strings.menu.file,
      submenu: [
        { label: strings.menu.createNote, accelerator: 'Ctrl+N', click: () => mainWindow.webContents.send('menu-create') },
        { label: strings.menu.open, accelerator: 'Ctrl+O', click: () => mainWindow.webContents.send('menu-open') },
        { label: strings.menu.save, accelerator: 'Ctrl+S', click: () => mainWindow.webContents.send('menu-save') },
        { label: strings.menu.saveAs, accelerator: 'Ctrl+Shift+S', click: () => mainWindow.webContents.send('menu-save-as') },
        { type: 'separator' },
        { label: strings.menu.quit, role: 'quit' }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function loadCredentials() {
  if (!fs.existsSync(CREDENTIALS_FILE)) {
    // Ask the user to locate the credentials JSON
    const res = dialog.showOpenDialogSync(mainWindow, {
      title: 'Select Google OAuth credentials JSON',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (!res || res.length === 0) {
      throw new Error(`Missing credentials.json in project root. See README.md`);
    }
    // copy selected file into project root as credentials.json
    try {
      fs.copyFileSync(res[0], CREDENTIALS_FILE);
    } catch (err) {
      throw new Error('Failed to copy credentials file: ' + err.message);
    }
  }
  const content = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
  const credentials = JSON.parse(content);
  // Support both web and installed formats
  const conf = credentials.installed || credentials.web || credentials;
  const clientId = conf.client_id;
  const clientSecret = conf.client_secret;
  return { clientId, clientSecret };
}

ipcMain.handle('start-auth', async () => {
  try {
    const { clientId, clientSecret } = loadCredentials();
    oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      OAUTH_CALLBACK
    );

    // Restore tokens if present
    if (fs.existsSync(TOKEN_FILE)) {
      const tok = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      oauth2Client.setCredentials(tok);
      // Quick test: verify the token has access to appDataFolder (drive.appdata)
      try {
        const driveTest = google.drive({ version: 'v3', auth: oauth2Client });
        await driveTest.files.list({ spaces: 'appDataFolder', pageSize: 1, fields: 'files(id)' });
        // fetch and send notes to renderer so UI shows post-its immediately
        try {
          const notes = await fetchNotes();
          if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('notes-updated', notes);
        } catch (e) {
          console.error('Failed to fetch notes after token restore:', e);
        }
        return { success: true };
      } catch (err) {
        // Only remove token if it's definitely an invalid grant or expired/wrong scope
        // If it's just no internet (ENOTFOUND, ETIMEDOUT), keep the token
        const errorMsg = err.message || '';
        if (errorMsg.includes('invalid_grant') || errorMsg.includes('insufficient permissions')) {
          console.log('Token invalid or insufficient. Removing token file.');
          try {
            fs.unlinkSync(TOKEN_FILE);
          } catch (e) {
            console.error('Failed to remove token file:', e);
          }
        } else {
          console.error('Network error during auto-connect:', errorMsg);
          return { success: false, error: 'Offline or Network error' };
        }
        // continue to generate new auth URL if it was an auth error
      }
    }

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/drive.appdata',
        'https://www.googleapis.com/auth/drive'
      ],
      prompt: 'consent'
    });

    // Open an in-app BrowserWindow to perform OAuth and capture redirect
    const authWindow = new BrowserWindow({
      width: 600,
      height: 700,
      parent: mainWindow,
      modal: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    authWindow.loadURL(authUrl);

    return await new Promise((resolve, reject) => {
      const handleRedirect = async (newUrl) => {
        try {
          if (!newUrl) return;
          // When the auth flow redirects to our callback URL, capture code
          if (newUrl.startsWith(OAUTH_CALLBACK)) {
            const u = new URL(newUrl);
            const code = u.searchParams.get('code');
            if (!code) {
              reject(new Error('No code in callback'));
              authWindow.close();
              return;
            }
            const r = await oauth2Client.getToken(code);
            oauth2Client.setCredentials(r.tokens);
            fs.writeFileSync(TOKEN_FILE, JSON.stringify(r.tokens, null, 2));
            // Ensure app storage folder exists in user's Drive (appDataFolder)
            try {
              await ensureAppDataFolder();
            } catch (err) {
              // non-fatal, continue but log
              console.error('ensureAppDataFolder failed:', err);
            }
            // fetch notes and send to renderer
            try {
              const notes = await fetchNotes();
              if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('notes-updated', notes);
            } catch (e) {
              console.error('Failed to fetch notes after auth:', e);
            }
            resolve({ success: true });
            authWindow.close();
          }
        } catch (err) {
          reject(err);
          authWindow.close();
        }
      };

      authWindow.webContents.on('will-redirect', (event, newUrl) => {
        handleRedirect(newUrl);
      });

      // Some flows use navigation instead of redirect
      authWindow.webContents.on('did-navigate', (event, newUrl) => {
        handleRedirect(newUrl);
      });

      authWindow.on('closed', () => {
        reject(new Error('Auth window closed by user'));
      });
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

async function ensureAppDataFolder() {
  if (!oauth2Client) throw new Error('OAuth2 client not initialized');
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  // Look for a folder named 'notes' in the appDataFolder
  const res = await drive.files.list({
    spaces: 'appDataFolder',
    q: "name = 'notes' and mimeType = 'application/vnd.google-apps.folder'",
    fields: 'files(id,name)'
  });
  let folder = res.data.files && res.data.files[0];
  if (!folder) {
    const createRes = await drive.files.create({
      resource: {
        name: 'notes',
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['appDataFolder']
      },
      fields: 'id,name'
    });
    folder = createRes.data;
  }
  return folder;
}

async function getOrCreateMetadata(folder, drive) {
  // Look for metadata.json inside the folder
  const res = await drive.files.list({
    q: `'${folder.id}' in parents and name = 'metadata.json' and trashed = false`,
    spaces: 'appDataFolder',
    fields: 'files(id,name)'
  });
  let metaFile = res.data.files && res.data.files[0];
  if (!metaFile) {
    const initial = { lastId: 0, items: [] };
    const createRes = await drive.files.create({
      resource: { name: 'metadata.json', parents: [folder.id] },
      media: { mimeType: 'application/json', body: JSON.stringify(initial, null, 2) },
      spaces: 'appDataFolder',
      fields: 'id,name'
    });
    return { id: createRes.data.id, data: initial };
  }
  // read it
  const r = await drive.files.get({ fileId: metaFile.id, alt: 'media' }, { responseType: 'arraybuffer' });
  const content = Buffer.from(r.data).toString('utf8');
  try {
    const parsed = JSON.parse(content || '{}');
    return { id: metaFile.id, data: parsed };
  } catch (err) {
    // corrupted, replace
    const initial = { lastId: 0, items: [] };
    await drive.files.update({ fileId: metaFile.id, media: { mimeType: 'application/json', body: JSON.stringify(initial, null, 2) } });
    return { id: metaFile.id, data: initial };
  }
}

async function writeMetadata(metaFileId, drive, data) {
  if (!metaFileId) throw new Error('metadata file id required');
  await drive.files.update({ fileId: metaFileId, media: { mimeType: 'application/json', body: JSON.stringify(data, null, 2) } });
}

async function fetchNotes() {
  if (!oauth2Client) throw new Error('OAuth2 client not initialized');
  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  const folder = await ensureAppDataFolder();
  const meta = await getOrCreateMetadata(folder, drive);
  const res = await drive.files.list({
    q: `'${folder.id}' in parents and trashed = false and name != 'metadata.json'`,
    spaces: 'appDataFolder',
    fields: 'files(id,name,mimeType,modifiedTime)'
  });
  const files = res.data.files || [];
  const notesPromises = files.map(async (f) => {
    try {
      const r2 = await drive.files.get({ fileId: f.id, alt: 'media' }, { responseType: 'arraybuffer' });
      const buf = Buffer.from(r2.data);
      const lowerName = (f.name || '').toLowerCase();
      const isZip = lowerName.endsWith('.knote') || f.mimeType === 'application/zip' || f.mimeType === 'application/x-zip-compressed' || lowerName.endsWith('.zip');
      
      let content = '';
      let attachments = [];

      if (isZip) {
        try {
          const zip = new AdmZip(buf);
          const entry = zip.getEntry('note.txt');
          if (entry) {
            content = decodeBuffer(entry.getData());
          } else {
            const textEntry = zip.getEntries().find(e => !e.isDirectory && e.entryName.toLowerCase().endsWith('.txt'));
            content = textEntry ? decodeBuffer(textEntry.getData()) : '';
          }
          // Extract attachments
          attachments = zip.getEntries()
            .filter(e => e.entryName.startsWith('attachments/') && !e.isDirectory)
            .map(e => {
              // Extracting name manually to avoid any path.basename issues with slashes
              const parts = e.entryName.split('/');
              const name = parts[parts.length - 1];
              return {
                name: name,
                dataBase64: e.getData().toString('base64')
              };
            });
          console.log(`Nota ZIP carregada: ${f.name} com ${attachments.length} anexos.`);
        } catch (err) {
          console.error(`Erro ao ler ZIP ${f.name}:`, err);
        }
      } else {
        content = decodeBuffer(buf);
      }

      const metaItem = (meta && meta.data && Array.isArray(meta.data.items)) ? meta.data.items.find(i => i.fileId === f.id) : null;
      return {
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        modifiedTime: f.modifiedTime,
        content,
        attachments,
        color: metaItem ? metaItem.color : null,
        seq: metaItem ? metaItem.seq : null,
        createdAt: metaItem ? metaItem.createdAt : null
      };
    } catch (err) {
      console.error(`Erro ao processar arquivo ${f.id}:`, err);
      return null;
    }
  });

  const allNotes = await Promise.all(notesPromises);
  return allNotes.filter(n => n !== null); // Remove failed ones
}

ipcMain.handle('list-notes', async () => {
  try {
    if (!oauth2Client) {
      // try load tokens from file
      const { clientId, clientSecret } = loadCredentials();
      oauth2Client = new google.auth.OAuth2(clientId, clientSecret, OAUTH_CALLBACK);
      if (fs.existsSync(TOKEN_FILE)) {
        const tok = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        oauth2Client.setCredentials(tok);
      } else {
        throw new Error('No tokens found, please authenticate first.');
      }
    }
    const notes = await fetchNotes();
    return { success: true, notes };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Open file dialog and read note (txt or .knote/.zip)
ipcMain.handle('open-file-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Notes', extensions: ['knote', 'zip', 'txt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (canceled || !filePaths || filePaths.length === 0) return { canceled: true };
  const p = filePaths[0];
  if (p.endsWith('.txt')) {
    const buf = fs.readFileSync(p);
    const text = decodeBuffer(buf);
    return { canceled: false, type: 'txt', path: p, text };
  }
  try {
    const zip = new AdmZip(p);
    const noteEntry = zip.getEntry('note.txt');
    const text = noteEntry ? decodeBuffer(noteEntry.getData()) : '';
    const attachments = zip.getEntries()
      .filter(e => e.entryName.startsWith('attachments/') && !e.isDirectory)
      .map(e => ({ name: path.basename(e.entryName), dataBase64: e.getData().toString('base64') }));
    return { canceled: false, type: 'knote', path: p, text, attachments };
  } catch (err) {
    return { canceled: false, type: 'unknown', path: p, error: err.message };
  }
});

ipcMain.handle('show-save-dialog', async (event, defaultName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [
      { name: 'Text', extensions: ['txt'] },
      { name: 'Keep Note (zip)', extensions: ['knote', 'zip'] }
    ]
  });
  if (canceled) return { canceled: true };
  return { canceled: false, filePath };
});

ipcMain.handle('save-file', async (event, filePath, noteData) => {
  try {
    const encoding = noteData.encoding || 'utf8';
    if (filePath.endsWith('.txt')) {
      const buf = iconv.encode(noteData.text || '', encoding);
      fs.writeFileSync(filePath, buf);
      return { success: true, path: filePath };
    }
    const zip = new AdmZip();
    zip.addFile('note.txt', iconv.encode(noteData.text || '', encoding));
    if (Array.isArray(noteData.attachments)) {
      noteData.attachments.forEach(att => {
        zip.addFile('attachments/' + att.name, Buffer.from(att.dataBase64, 'base64'));
      });
    }
    zip.writeZip(filePath);
    return { success: true, path: filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('show-open-attachment-dialog', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (canceled) return { canceled: true };
  return { canceled: false, filePaths };
});

ipcMain.handle('create-note', async (event, note) => {
  try {
    if (!oauth2Client) {
      const { clientId, clientSecret } = loadCredentials();
      oauth2Client = new google.auth.OAuth2(clientId, clientSecret, OAUTH_CALLBACK);
      if (fs.existsSync(TOKEN_FILE)) {
        const tok = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        oauth2Client.setCredentials(tok);
      } else {
        throw new Error('No tokens found, please authenticate first.');
      }
    }
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const folder = await ensureAppDataFolder();
    const meta = await getOrCreateMetadata(folder, drive);
    const nextId = (meta && meta.data) ? (meta.data.lastId || 0) + 1 : 1;
    const seqStr = String(nextId).padStart(4, '0');
    const safeTitle = (note && note.title) ? note.title.replace(/[^a-z0-9\-_. ]/gi, '_') : 'note';
    let fileName = `${seqStr} - ${safeTitle}.txt`;
    let res;
    if (note && Array.isArray(note.attachments) && note.attachments.length > 0) {
      // create .knote zip
      const zip = new AdmZip();
      zip.addFile('note.txt', iconv.encode((note && note.content) ? note.content : '', note.encoding || 'utf8'));
      note.attachments.forEach(att => {
        zip.addFile('attachments/' + att.name, Buffer.from(att.dataBase64, 'base64'));
      });
      const buf = zip.toBuffer();
      fileName = `${seqStr} - ${safeTitle}.knote`;
      res = await drive.files.create({ 
        resource: { name: fileName, parents: [folder.id] }, 
        media: { mimeType: 'application/zip', body: Readable.from(buf) }, 
        spaces: 'appDataFolder', 
        fields: 'id,name,mimeType,modifiedTime' 
      });
    } else {
      const bodyBuf = iconv.encode((note && note.content) ? note.content : '', note.encoding || 'utf8');
      const media = { mimeType: 'text/plain', body: Readable.from(bodyBuf) };
      res = await drive.files.create({ 
        resource: { name: fileName, parents: [folder.id] }, 
        media, 
        spaces: 'appDataFolder', 
        fields: 'id,name,mimeType,modifiedTime' 
      });
    }
    // update metadata
    if (meta && meta.data) {
      meta.data.lastId = nextId;
      meta.data.items = meta.data.items || [];
      meta.data.items.push({ 
        seq: nextId, 
        fileId: res.data.id, 
        name: res.data.name, 
        createdAt: new Date().toISOString(),
        color: note.color || '#fff9a8'
      });
      await writeMetadata(meta.id, drive, meta.data);
    }
    try {
      const notes = await fetchNotes();
      console.log('create-note created file', res.data.id, 'total notes now', (notes && notes.length) || 0);
      return { success: true, file: res.data, notes };
    } catch (e) {
      console.error('create-note: failed to fetch notes after create', e);
      return { success: true, file: res.data };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('update-note', async (event, payload) => {
  try {
    const { fileId, title, content, attachments } = payload || {};
    if (!fileId) throw new Error('fileId required');
    if (!oauth2Client) {
      const { clientId, clientSecret } = loadCredentials();
      oauth2Client = new google.auth.OAuth2(clientId, clientSecret, OAUTH_CALLBACK);
      if (fs.existsSync(TOKEN_FILE)) {
        const tok = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        oauth2Client.setCredentials(tok);
      } else {
        throw new Error('No tokens found, please authenticate first.');
      }
    }
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const folder = await ensureAppDataFolder();
    const meta = await getOrCreateMetadata(folder, drive);
    const safeTitle = (title) ? title.replace(/[^a-z0-9\-_. ]/gi, '_') : 'note';
    let newName = `${safeTitle}.txt`;
    let res;
    const encoding = payload.encoding || 'utf8';
    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      // build zip and update with .knote
      const zip = new AdmZip();
      zip.addFile('note.txt', iconv.encode(content || '', encoding));
      attachments.forEach(att => {
        zip.addFile('attachments/' + att.name, Buffer.from(att.dataBase64, 'base64'));
      });
      const buf = zip.toBuffer();
      newName = `${safeTitle}.knote`;
      res = await drive.files.update({ 
        fileId, 
        resource: { name: newName }, 
        media: { mimeType: 'application/zip', body: Readable.from(buf) }, 
        fields: 'id,name,mimeType,modifiedTime' 
      });
    } else {
      // plain text update
      const bodyBuf = iconv.encode(content || '', encoding);
      const media = { mimeType: 'text/plain', body: Readable.from(bodyBuf) };
      newName = `${safeTitle}.txt`;
      res = await drive.files.update({ 
        fileId, 
        resource: { name: newName }, 
        media, 
        fields: 'id,name,mimeType,modifiedTime' 
      });
    }
    // update metadata entry name if exists, or create if missing
    if (meta && meta.data) {
      meta.data.items = meta.data.items || [];
      const item = meta.data.items.find(i => i.fileId === fileId);
      if (item) {
        item.name = res.data.name;
        if (payload.color) item.color = payload.color;
      } else {
        // If it's a legacy note not in metadata, add it now
        meta.data.items.push({
          fileId: fileId,
          name: res.data.name,
          color: payload.color || '#fff9a8',
          createdAt: new Date().toISOString()
        });
      }
      await writeMetadata(meta.id, drive, meta.data);
    }
    try {
      const notes = await fetchNotes();
      console.log('update-note updated file', res.data.id, 'total notes now', (notes && notes.length) || 0);
      return { success: true, file: res.data, notes };
    } catch (e) {
      console.error('update-note: failed to fetch notes after update', e);
      return { success: true, file: res.data };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('delete-note', async (event, fileId) => {
  try {
    if (!fileId) throw new Error('fileId required');
    if (!oauth2Client) throw new Error('OAuth2 client not initialized');
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    
    // Move to trash or delete permanently? User said "excluir o arquivo do drive"
    // Usually trash is safer, but delete is more direct. Let's use trash for safety or delete as requested.
    // I'll use delete to be permanent as per "excluir".
    await drive.files.delete({ fileId });

    // Update metadata to remove the item
    const folder = await ensureAppDataFolder();
    const meta = await getOrCreateMetadata(folder, drive);
    if (meta && meta.data && Array.isArray(meta.data.items)) {
      meta.data.items = meta.data.items.filter(i => i.fileId !== fileId);
      await writeMetadata(meta.id, drive, meta.data);
    }

    const notes = await fetchNotes();
    return { success: true, notes };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('check-drive', async () => {
  try {
    if (!oauth2Client) {
      const { clientId, clientSecret } = loadCredentials();
      oauth2Client = new google.auth.OAuth2(clientId, clientSecret, OAUTH_CALLBACK);
      if (fs.existsSync(TOKEN_FILE)) {
        const tok = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        oauth2Client.setCredentials(tok);
      } else {
        return { success: false, error: 'No tokens found, please authenticate first.' };
      }
    }
    const drive = google.drive({ version: 'v3', auth: oauth2Client });
    const folder = await ensureAppDataFolder();
    const meta = await getOrCreateMetadata(folder, drive);
    return { success: true, folderId: folder.id, metadataId: meta && meta.id };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

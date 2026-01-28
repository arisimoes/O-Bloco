const { ipcRenderer } = require('electron');

const btnConnect = document.getElementById('btnConnect');
const btnCreate = document.getElementById('btnCreate');
const notesEl = document.getElementById('notes');
const tabsEl = document.getElementById('tabs');
const attachmentsEl = document.getElementById('attachments');
const editorModal = document.getElementById('editorModal');
const editorModalContent = document.getElementById('editorModalContent');
const noteTitleInput = document.getElementById('noteTitle');
const noteContentInput = document.getElementById('noteContent');
const noteEncodingEl = document.getElementById('noteEncoding');
const noteColorEl = document.getElementById('noteColor');
const btnModalSave = document.getElementById('btnModalSave');
const btnModalCancel = document.getElementById('btnModalCancel');
const btnModalDelete = document.getElementById('btnModalDelete');
const notePreview = document.getElementById('notePreview');
const previewContainer = document.getElementById('previewContainer');
const charCount = document.getElementById('charCountVal');
const validationMsg = document.getElementById('validationMsg');
const btnModalAttach = document.getElementById('btnModalAttach');
const modalAttachmentsEl = document.getElementById('modalAttachments');

let modalAttachments = [];
let editingFileId = null;

// If `btnConnect` exists keep it functional, but the UI normally hides it.
if (btnConnect) {
  btnConnect.addEventListener('click', async () => {
    btnConnect.disabled = true;
    btnConnect.textContent = 'Conectando...';
    const res = await ipcRenderer.invoke('start-auth');
    if (res.success) {
      btnConnect.textContent = 'Conectado';
    } else {
      btnConnect.textContent = 'Conectar Google';
      alert('Erro: ' + (res.error || 'unknown'));
    }
    btnConnect.disabled = false;
  });
}

// Automatically attempt to authenticate on load so the app keeps a connection
// to Google without requiring a visible "Connect" button.
(async function autoConnect() {
  try {
    const res = await ipcRenderer.invoke('start-auth');
    const driveStatus = document.getElementById('driveStatus');
    if (res && res.success) {
      if (driveStatus) driveStatus.textContent = 'Conectado ao Google';
      // After successful auth, immediately request notes listing so UI is populated
      try {
        const listRes = await ipcRenderer.invoke('list-notes');
        if (listRes && listRes.success) {
          renderNotes(listRes.notes);
        }
      } catch (e) {
        console.error('Failed to list notes after autoConnect:', e);
      }
    } else {
      if (driveStatus) driveStatus.textContent = 'Não conectado';
    }
  } catch (e) {
    const driveStatus = document.getElementById('driveStatus');
    if (driveStatus) driveStatus.textContent = 'Erro na autenticação';
    console.error('autoConnect error', e);
  }
})();

// Receive automatic notes after auth
ipcRenderer.on('notes-updated', (event, notes) => {
  try { if (notes && Array.isArray(notes)) renderNotes(notes); } catch (e) { console.error(e); }
});


btnCreate.addEventListener('click', () => {
  // open modal editor
  editingFileId = null;
  noteTitleInput.value = 'Nova nota';
  noteContentInput.value = '';
  noteEncodingEl.value = 'utf8';
  noteColorEl.value = '#fff9a8';
  
  // Reset modal color preview
  if (editorModalContent) editorModalContent.style.background = '#fff9a8';

  btnModalDelete.style.display = 'none'; // Hide delete button for new notes
  updatePreviewAndValidation();
  editorModal.style.display = 'flex';
  noteTitleInput.focus();
});

btnModalDelete.addEventListener('click', async () => {
  if (!editingFileId) return;
  if (!confirm('Tem certeza que deseja excluir esta nota permanentemente do Google Drive?')) return;
  
  btnModalDelete.disabled = true;
  btnModalDelete.textContent = 'Excluindo...';
  
  const res = await ipcRenderer.invoke('delete-note', editingFileId);
  
  btnModalDelete.disabled = false;
  btnModalDelete.textContent = 'Excluir Nota';
  
  if (res.success) {
    editorModal.style.display = 'none';
    renderNotes(res.notes);
  } else {
    alert('Erro ao excluir nota: ' + (res.error || 'unknown'));
  }
});

btnModalCancel.addEventListener('click', () => {
  editorModal.style.display = 'none';
});

btnModalSave.addEventListener('click', async () => {
  const title = noteTitleInput.value || 'note';
  const content = noteContentInput.value || '';
  const encoding = noteEncodingEl.value || 'utf8';
  const color = noteColorEl.value || '#fff9a8';
  btnModalSave.disabled = true;
  btnModalSave.textContent = 'Salvando...';
  let res;
  if (editingFileId) {
    res = await ipcRenderer.invoke('update-note', { fileId: editingFileId, title, content, attachments: modalAttachments, encoding, color });
  } else {
    res = await ipcRenderer.invoke('create-note', { title, content, attachments: modalAttachments, encoding, color });
  }
  btnModalSave.disabled = false;
  btnModalSave.textContent = 'Salvar';
  editorModal.style.display = 'none';
  if (!res || !res.success) {
    alert('Erro ao criar/atualizar nota: ' + (res && res.error || 'unknown'));
  } else {
    // if main returned notes, render them immediately; otherwise request list
    if (res.notes && Array.isArray(res.notes)) {
      renderNotes(res.notes);
    } else {
      const listRes = await ipcRenderer.invoke('list-notes');
      if (listRes && listRes.success) renderNotes(listRes.notes);
    }
  }
  // reset modal state
  modalAttachments = [];
  renderModalAttachments();
  editingFileId = null;
});

function updatePreviewAndValidation() {
  const title = (noteTitleInput.value || '').trim();
  const content = noteContentInput.value || '';
  
  // Update character count
  charCount.textContent = String(content.length);
  const legacyCharCount = document.getElementById('charCount');
  if (legacyCharCount) legacyCharCount.textContent = String(content.length);

  // Check for images in attachments
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'];
  const images = modalAttachments.filter(att => 
    imageExtensions.some(ext => att.name.toLowerCase().endsWith(ext))
  );

  if (images.length > 0) {
    previewContainer.style.display = 'block';
    notePreview.innerHTML = '';
    images.forEach(img => {
      const wrapper = document.createElement('div');
      wrapper.style.position = 'relative';
      const el = document.createElement('img');
      el.src = `data:image/unknown;base64,${img.dataBase64}`;
      el.style.maxHeight = '140px';
      el.style.maxWidth = '180px';
      el.style.border = '1px solid #ccc';
      el.style.borderRadius = '4px';
      wrapper.appendChild(el);
      notePreview.appendChild(wrapper);
    });
  } else {
    previewContainer.style.display = 'none';
    notePreview.innerHTML = '';
  }

  // Simple validation: title required
  if (!title) {
    validationMsg.style.display = 'block';
    btnModalSave.disabled = true;
  } else {
    validationMsg.style.display = 'none';
    btnModalSave.disabled = false;
  }
}

noteTitleInput.addEventListener('input', updatePreviewAndValidation);
noteContentInput.addEventListener('input', updatePreviewAndValidation);
noteColorEl.addEventListener('change', () => {
  if (editorModalContent) {
    editorModalContent.style.background = noteColorEl.value;
  }
});

function renderNotes(notes) {
  notesEl.innerHTML = '';
  tabsEl.innerHTML = '';
  if (!notes || notes.length === 0) {
    notesEl.textContent = 'Nenhuma nota encontrada.';
    return;
  }
  notes.forEach(raw => {
    const n = normalizeNote(raw);
    const d = document.createElement('div');
    d.className = 'note';
    // Use background instead of backgroundColor for better overrides
    if (n.color) d.style.background = n.color;
    
    const title = document.createElement('div');
    title.textContent = n.name;
    title.style.fontWeight = '700';
    title.style.fontSize = '1.1em';
    title.style.marginBottom = '2px';
    title.style.whiteSpace = 'nowrap';
    title.style.overflow = 'hidden';
    title.style.textOverflow = 'ellipsis';

    const date = document.createElement('div');
    date.style.fontSize = '0.75em';
    date.style.color = '#555';
    date.style.marginBottom = '8px';
    const timestamp = n.modifiedTime || n.createdAt;
    date.textContent = timestamp ? new Date(timestamp).toLocaleString('pt-BR') : '';

    const body = document.createElement('div');
    body.className = 'note-body';
    body.textContent = n.content || '';

    d.appendChild(title);
    d.appendChild(date);
    d.appendChild(body);
    
    // Click opens the edit modal directly
    d.addEventListener('click', () => {
      // open modal in edit mode for this note
      editingFileId = n.id;
      noteTitleInput.value = n.name;
      noteContentInput.value = n.content || '';
      noteEncodingEl.value = 'utf8';
      const color = n.color || '#fff9a8';
      noteColorEl.value = color;
      
      // Update modal color preview immediately
      if (editorModalContent) editorModalContent.style.background = color;

      modalAttachments = n.attachments ? JSON.parse(JSON.stringify(n.attachments)) : [];
      btnModalDelete.style.display = 'block'; // Show delete button in edit mode
      renderModalAttachments();
      updatePreviewAndValidation();
      editorModal.style.display = 'flex';
      noteTitleInput.focus();
    });
    notesEl.appendChild(d);
  });
}

function normalizeNote(raw) {
  if (!raw) return {};
  const path = require('path');
  let rawName = raw.name || raw.title || raw.path || '(sem título)';
  
  // 1. Get basename (remove path)
  let name = (typeof rawName === 'string') ? path.basename(rawName) : rawName;
  
  // 2. Remove extension (.txt, .knote, .zip)
  name = name.replace(/\.(txt|knote|zip)$/i, '');
  
  // 3. Remove sequential prefix "0001 - " if present
  name = name.replace(/^\d{4}\s*-\s*/, '');

  return {
    id: raw.id || raw.fileId || null,
    name: name,
    content: raw.content || raw.textContent || raw.text || '',
    attachments: raw.attachments || [],
    color: raw.color || null,
    seq: raw.seq || null,
    createdAt: raw.createdAt || raw.created_at || null,
    modifiedTime: raw.modifiedTime || raw.modified_time || null,
    _sourceName: raw.name || raw.title || raw.path || null
  };
}

function openTab(note) {
  const t = document.createElement('div');
  t.className = 'tab';
  const h = document.createElement('h3');
  h.textContent = note.name || '(sem título)';
  const p = document.createElement('pre');
  p.textContent = note.content || '';
  const editBtn = document.createElement('button');
  editBtn.textContent = 'Editar';
  editBtn.style.marginLeft = '8px';
  editBtn.addEventListener('click', () => {
    // open modal in edit mode
    editingFileId = note.id;
    noteTitleInput.value = note.name || 'note';
    noteContentInput.value = note.content || '';
    noteEncodingEl.value = 'utf8';
    modalAttachments = note.attachments ? note.attachments.slice() : [];
    renderModalAttachments();
    updatePreviewAndValidation();
    editorModal.style.display = 'flex';
    noteTitleInput.focus();
  });
  t.appendChild(h);
  t.appendChild(editBtn);
  t.appendChild(p);
  tabsEl.appendChild(t);
  currentNote = {
    id: note.id,
    title: note.name || '(sem título)',
    text: note.content || '',
    attachments: note.attachments || [],
    seq: note.seq,
    createdAt: note.createdAt
  };
  renderAttachments();
}

let currentNote = null;

function renderAttachments() {
  attachmentsEl.innerHTML = '';
  if (!currentNote || !currentNote.attachments || currentNote.attachments.length === 0) {
    attachmentsEl.textContent = '';
    return;
  }
  currentNote.attachments.forEach(att => {
    const d = document.createElement('div');
    d.textContent = att.name;
    attachmentsEl.appendChild(d);
  });
}



btnModalAttach.addEventListener('click', async () => {
  const res = await ipcRenderer.invoke('show-open-attachment-dialog');
  if (res.canceled) return;
  for (const fp of res.filePaths) {
    const buffer = require('fs').readFileSync(fp);
    const b64 = buffer.toString('base64');
    modalAttachments.push({ name: require('path').basename(fp), dataBase64: b64 });
  }
  renderModalAttachments();
  updatePreviewAndValidation(); // Ensure preview updates after attaching
});

function renderModalAttachments() {
  modalAttachmentsEl.innerHTML = '';
  modalAttachments.forEach((att, idx) => {
    const d = document.createElement('div');
    d.textContent = att.name;
    d.style.padding = '4px 6px';
    d.style.background = '#fff';
    d.style.border = '1px solid #ddd';
    d.style.borderRadius = '4px';
    const rm = document.createElement('button');
    rm.textContent = 'x';
    rm.style.marginLeft = '6px';
    rm.addEventListener('click', () => { 
      modalAttachments.splice(idx,1); 
      renderModalAttachments(); 
      updatePreviewAndValidation(); // Update preview after removal
    });
    d.appendChild(rm);
    modalAttachmentsEl.appendChild(d);
  });
}

// Menu actions
const { ipcRenderer: ipc } = require('electron');
ipc.on('menu-open', async () => {
  const r = await ipcRenderer.invoke('open-file-dialog');
  if (r.canceled) return;
  try {
    // When opening a local file, import it into Drive automatically and open editor
    if (r.type === 'txt') {
      const path = require('path');
      const title = path.basename(r.path || 'note.txt');
      const createRes = await ipcRenderer.invoke('create-note', { title, content: r.text, attachments: [] });
      if (!createRes || !createRes.success) throw new Error(createRes && createRes.error || 'create-note failed');
      // refresh list and open the created note in editor
      const listRes = await ipcRenderer.invoke('list-notes');
      if (listRes && listRes.success) renderNotes(listRes.notes);
      const createdId = createRes.file && createRes.file.id;
      if (createdId) {
        const note = (listRes.notes || []).find(n => n.id === createdId);
        if (note) {
          editingFileId = note.id;
          noteTitleInput.value = note.name || title;
          noteContentInput.value = note.content || r.text;
          noteEncodingEl.value = 'utf8';
          modalAttachments = note.attachments ? note.attachments.slice() : [];
          renderModalAttachments();
          updatePreviewAndValidation();
          editorModal.style.display = 'flex';
          noteTitleInput.focus();
        }
      }
    } else if (r.type === 'knote') {
      const path = require('path');
      const title = path.basename(r.path || 'note.knote');
      const createRes = await ipcRenderer.invoke('create-note', { title, content: r.text, attachments: r.attachments });
      if (!createRes || !createRes.success) throw new Error(createRes && createRes.error || 'create-note failed');
      const listRes = await ipcRenderer.invoke('list-notes');
      if (listRes && listRes.success) renderNotes(listRes.notes);
      const createdId = createRes.file && createRes.file.id;
      if (createdId) {
        const note = (listRes.notes || []).find(n => n.id === createdId);
        if (note) {
          editingFileId = note.id;
          noteTitleInput.value = note.name || title;
          noteContentInput.value = note.content || r.text;
          noteEncodingEl.value = 'utf8';
          modalAttachments = note.attachments ? note.attachments.slice() : r.attachments || [];
          renderModalAttachments();
          updatePreviewAndValidation();
          editorModal.style.display = 'flex';
          noteTitleInput.focus();
        }
      }
    } else {
      alert('Arquivo aberto: ' + (r.path || '') + (r.error ? '\nErro: ' + r.error : ''));
    }
  } catch (err) {
    alert('Erro ao importar arquivo: ' + (err && err.message || err));
  }
});

ipc.on('menu-save', async () => {
  if (!currentNote) return alert('Abra ou selecione uma nota para salvar.');
  const def = (currentNote.title || 'note') + '.knote';
  const res = await ipcRenderer.invoke('show-save-dialog', def);
  if (res.canceled) return;
  const saveRes = await ipcRenderer.invoke('save-file', res.filePath, { text: currentNote.text, attachments: currentNote.attachments });
  if (saveRes.success) alert('Salvo: ' + saveRes.path);
  else alert('Erro ao salvar: ' + saveRes.error);
});



ipc.on('menu-save-as', async () => {
  // same as save for now
  ipc.emit('menu-save');
});

// Note: explicit DOMContentLoaded connect removed because UI has no connect button.
// autoConnect() above performs authentication and initial listing on startup.

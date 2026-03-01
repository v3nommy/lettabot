import * as http from 'http';
import * as path from 'path';
import { promises as fs } from 'fs';
import crypto from 'crypto';

const BASE_PATH = '/admin/files';

// Volume root: prefer Railway-provided mount path if present, otherwise /data
const DATA_ROOT = (process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data').trim();

// Auth
const AUTH_USER = (process.env.FILE_ADMIN_USER || 'admin').trim();
const AUTH_PASS_HASH = (process.env.FILE_ADMIN_PASS_HASH || '').trim().toLowerCase();

// Preview whitelist (text-like only)
const PREVIEW_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.log', '.csv', '.yml', '.yaml',
  '.js', '.ts', '.html', '.css', '.py', '.sh', '.conf', '.config',
  '.gitignore', '.dockerignore', '.properties', '.xml', '.sql',
]);

// Limits
const MAX_PREVIEW_BYTES = 1024 * 1024; // 1MB

// Resolved root for jail checks
const RESOLVED_ROOT = path.resolve(DATA_ROOT);
const ROOT_WITH_SEP = RESOLVED_ROOT + path.sep;

function send(res: http.ServerResponse, status: number, headers: Record<string, string>, body: string | Buffer) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, obj: unknown) {
  send(res, status, { 'Content-Type': 'application/json' }, JSON.stringify(obj));
}

function unauthorized(res: http.ServerResponse) {
  res.setHeader('WWW-Authenticate', 'Basic realm="File Explorer"');
  send(res, 401, { 'Content-Type': 'text/plain' }, 'Unauthorized');
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex').toLowerCase();
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function parseBasicAuth(req: http.IncomingMessage): { user: string; pass: string } | null {
  const auth = req.headers['authorization'];
  if (!auth || typeof auth !== 'string' || !auth.startsWith('Basic ')) return null;

  let decoded = '';
  try {
    decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  } catch {
    return null;
  }

  const idx = decoded.indexOf(':');
  if (idx === -1) return null;

  return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
}

function isAuthed(req: http.IncomingMessage): boolean {
  // Fail closed if hash not set
  if (!AUTH_PASS_HASH) return false;

  const creds = parseBasicAuth(req);
  if (!creds) return false;

  if (creds.user !== AUTH_USER) return false;

  const passHash = sha256Hex(creds.pass);
  return timingSafeEqualHex(passHash, AUTH_PASS_HASH);
}

async function resolveSafePath(relPath: string): Promise<string | null> {
  const raw = String(relPath || '');
  const normalized = path.normalize(raw).replace(/^\/+|\/+$/g, '');

  // Block traversal segments
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  if (parts.some((p) => p === '..')) return null;

  const tentative = parts.length ? path.join(RESOLVED_ROOT, ...parts) : RESOLVED_ROOT;

  try {
    const real = await fs.realpath(tentative);
    const inRoot = real === RESOLVED_ROOT || real.startsWith(ROOT_WITH_SEP);
    if (!inRoot) return null;
    return real;
  } catch {
    return null;
  }
}

function getUrl(req: http.IncomingMessage): URL {
  // We only need parsing; host can be dummy
  return new URL(req.url || '/', 'http://localhost');
}

function stripBase(p: string): string {
  // Remove /admin/files prefix
  if (p === BASE_PATH) return '';
  if (p.startsWith(BASE_PATH + '/')) return p.slice((BASE_PATH + '/').length);
  return p;
}

function buildUiHtml(): string {
  // Minimal, single-file UI (read-only). Calls our own endpoints under /admin/files/api/*
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>File Explorer - ${escapeHtml(DATA_ROOT)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      height: 100vh;
      overflow: hidden;
    }
    .container { display: flex; height: 100vh; }
    .sidebar { width: 280px; background: #1e293b; border-right: 1px solid #334155; overflow-y: auto; padding: 1rem; }
    .main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    .header { background: #1e293b; padding: 1rem 1.5rem; border-bottom: 1px solid #334155; display: flex; align-items: center; gap: 1rem; }
    .breadcrumb { flex: 1; font-size: 0.9rem; color: #94a3b8; }
    .breadcrumb a { color: #60a5fa; text-decoration: none; cursor: pointer; }
    .breadcrumb a:hover { text-decoration: underline; }
    .breadcrumb span { color: #64748b; margin: 0 0.5rem; }
    .content { flex: 1; overflow-y: auto; padding: 1.5rem; }
    .file-list { display: grid; gap: 0.5rem; }
    .file-item { display: flex; align-items: center; padding: 0.75rem 1rem; background: #1e293b; border: 1px solid #334155; border-radius: 6px; cursor: pointer; transition: all 0.2s; }
    .file-item:hover { background: #334155; border-color: #475569; }
    .file-icon { width: 24px; height: 24px; margin-right: 0.75rem; display: flex; align-items: center; justify-content: center; font-size: 1.1rem; }
    .file-name { flex: 1; font-size: 0.95rem; }
    .file-actions { display: flex; gap: 0.5rem; opacity: 0; transition: opacity 0.2s; }
    .file-item:hover .file-actions { opacity: 1; }
    .btn { padding: 0.4rem 0.8rem; border: none; border-radius: 4px; cursor: pointer; font-size: 0.8rem; text-decoration: none; display: inline-flex; align-items: center; gap: 0.3rem; }
    .btn-primary { background: #3b82f6; color: white; }
    .btn-primary:hover { background: #2563eb; }
    .btn-secondary { background: #475569; color: white; }
    .btn-secondary:hover { background: #64748b; }
    .preview-modal { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 1000; padding: 2rem; }
    .preview-content { background: #1e293b; max-width: 900px; max-height: 100%; margin: 0 auto; border-radius: 8px; overflow: hidden; display: flex; flex-direction: column; }
    .preview-header { padding: 1rem 1.5rem; border-bottom: 1px solid #334155; display: flex; justify-content: space-between; align-items: center; }
    .preview-title { font-weight: 600; }
    .preview-body { padding: 1.5rem; overflow-y: auto; flex: 1; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 0.9rem; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
    .empty-state { text-align: center; padding: 3rem; color: #64748b; }
    .folder-tree { margin-top: 1rem; }
    .tree-item { padding: 0.4rem 0.6rem; cursor: pointer; border-radius: 4px; display: flex; align-items: center; gap: 0.5rem; font-size: 0.9rem; }
    .tree-item:hover { background: #334155; }
    .tree-item.active { background: #3b82f6; color: white; }
    .tree-icon { font-size: 0.9rem; }
    .loading { opacity: 0.6; pointer-events: none; }
    .error { background: #7f1d1d; color: #fecaca; padding: 1rem; border-radius: 6px; margin-bottom: 1rem; }

    /* --- Mobile sidebar toggle (added) --- */
    @media (max-width: 768px) {
      .sidebar {
        position: fixed;
        left: -280px;
        top: 0;
        height: 100%;
        z-index: 2000;
        transition: left 0.25s ease;
      }
      .sidebar.open { left: 0; }
      .main { width: 100%; }
      .container { flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="container">
    <aside class="sidebar">
      <h3 style="margin-bottom: 1rem; font-size: 0.9rem; text-transform: uppercase; color: #64748b; letter-spacing: 0.05em;">
        📁 Navigation
      </h3>
      <div class="folder-tree" id="folderTree"></div>
    </aside>

    <main class="main">
      <header class="header">
        <!-- Mobile sidebar toggle button (added) -->
        <button onclick="toggleSidebar()" class="btn btn-secondary" aria-label="Toggle navigation">☰</button>

        <div class="breadcrumb" id="breadcrumb">${escapeHtml(DATA_ROOT)}</div>
      </header>

      <div class="content">
        <div id="errorContainer"></div>
        <div class="file-list" id="fileList"></div>
      </div>
    </main>
  </div>

  <div class="preview-modal" id="previewModal" onclick="closePreview(event)">
    <div class="preview-content" onclick="event.stopPropagation()">
      <div class="preview-header">
        <span class="preview-title" id="previewTitle">File Preview</span>
        <button class="btn btn-secondary" onclick="closePreview()">✕ Close</button>
      </div>
      <div class="preview-body" id="previewBody"></div>
    </div>
  </div>

  <script>
    let currentPath = '';

    /* Mobile sidebar toggle (added) */
    function toggleSidebar() {
      const sidebar = document.querySelector('.sidebar');
      if (sidebar) sidebar.classList.toggle('open');
    }

    function showError(msg) {
      document.getElementById('errorContainer').innerHTML = '<div class="error">' + msg + '</div>';
    }
    function clearError() { document.getElementById('errorContainer').innerHTML = ''; }

    async function loadDirectory(p) {
      p = (p || '').replace(/^\\//, '');
      currentPath = p;
      document.getElementById('fileList').classList.add('loading');
      clearError();

      try {
        const res = await fetch('${BASE_PATH}/api/list?path=' + encodeURIComponent(p));
        if (!res.ok) throw new Error('Failed to load');
        const data = await res.json();

        renderBreadcrumb(p);
        renderFileList(data.items);
        updateFolderTree(p);
      } catch (err) {
        showError('Failed to load directory: ' + (err && err.message ? err.message : err));
      } finally {
        document.getElementById('fileList').classList.remove('loading');
      }
    }

    function renderBreadcrumb(p) {
      const parts = p.split('/').filter(Boolean);
      let html = '<a onclick="loadDirectory(\\'\\')">${escapeJs(DATA_ROOT)}</a>';
      let buildPath = '';

      parts.forEach((part) => {
        buildPath = buildPath ? (buildPath + '/' + part) : part;
        html += ' <span>/</span> <a onclick="loadDirectory(\\'' + buildPath + '\\')">' + part + '</a>';
      });

      document.getElementById('breadcrumb').innerHTML = html;
    }

    function renderFileList(items) {
      if (!items || items.length === 0) {
        document.getElementById('fileList').innerHTML = '<div class="empty-state">This folder is empty</div>';
        return;
      }

      const html = items.map(item => {
        const icon = item.isDirectory ? '📁' : getFileIcon(item.name);
        const clickAction = item.isDirectory
          ? 'onclick="loadDirectory(\\'' + item.path + '\\')"'
          : 'onclick="previewFile(\\'' + item.path + '\\')"';

        return '<div class="file-item" ' + clickAction + '>' +
          '<span class="file-icon">' + icon + '</span>' +
          '<span class="file-name">' + item.name + '</span>' +
          '<div class="file-actions">' +
            (item.isDirectory ? '' :
              '<a class="btn btn-primary" href="${BASE_PATH}/api/download?path=' + encodeURIComponent(item.path) + '" download>⬇ Download</a>') +
          '</div>' +
        '</div>';
      }).join('');

      document.getElementById('fileList').innerHTML = html;
    }

    function getFileIcon(filename) {
      const ext = filename.split('.').pop().toLowerCase();
      const icons = { txt:'📄', md:'📝', json:'📋', js:'📜', html:'🌐', css:'🎨', py:'🐍', log:'📋', yml:'⚙️', yaml:'⚙️', csv:'📊', sql:'🗃️', sh:'⌨️' };
      return icons[ext] || '📄';
    }

    function updateFolderTree(activePath) {
      const parts = activePath.split('/').filter(Boolean);
      let html = '<div class="tree-item ' + (activePath === '' ? 'active' : '') + '" onclick="loadDirectory(\\'\\')"><span class="tree-icon">🏠</span> Root</div>';

      let buildPath = '';
      parts.forEach((part, i) => {
        buildPath = buildPath ? (buildPath + '/' + part) : part;
        const isLast = i === parts.length - 1;
        html += '<div class="tree-item ' + (isLast ? 'active' : '') + '" style="padding-left: ' + ((i + 1) * 12 + 12) + 'px" onclick="loadDirectory(\\'' + buildPath + '\\')">' +
                '<span class="tree-icon">📁</span>' + part + '</div>';
      });

      document.getElementById('folderTree').innerHTML = html;
    }

    async function previewFile(p) {
      p = (p || '').replace(/^\\//, '');
      try {
        const res = await fetch('${BASE_PATH}/api/preview?path=' + encodeURIComponent(p));
        if (!res.ok) {
          if (res.status === 415 || res.status === 413) {
            window.location.href = '${BASE_PATH}/api/download?path=' + encodeURIComponent(p);
            return;
          }
          throw new Error('Failed to load preview');
        }
        const data = await res.json();
        document.getElementById('previewTitle').textContent = data.name;
        document.getElementById('previewBody').textContent = data.content;
        document.getElementById('previewModal').style.display = 'flex';
      } catch (err) {
        showError('Failed to preview file: ' + (err && err.message ? err.message : err));
      }
    }

    function closePreview(e) {
      if (!e || e.target.id === 'previewModal') {
        document.getElementById('previewModal').style.display = 'none';
      }
    }

    loadDirectory('');
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c] as string));
}
function escapeJs(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function apiList(res: http.ServerResponse, rel: string) {
  const safe = await resolveSafePath(rel);
  if (!safe) return sendJson(res, 403, { error: 'Invalid path' });

  try {
    const entries = await fs.readdir(safe, { withFileTypes: true });
    const items = entries
      .filter((e) => !e.name.startsWith('.')) // hide dotfiles/dirs
      .map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        path: rel ? `${rel.replace(/^\/+|\/+$/g, '')}/${e.name}` : e.name,
      }))
      .sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));

    return sendJson(res, 200, { path: rel || '', items });
  } catch {
    return sendJson(res, 500, { error: 'Cannot read directory' });
  }
}

async function apiPreview(res: http.ServerResponse, rel: string) {
  const safe = await resolveSafePath(rel);
  if (!safe) return sendJson(res, 403, { error: 'Invalid path' });

  const ext = path.extname(rel).toLowerCase();
  if (!PREVIEW_EXTENSIONS.has(ext)) return sendJson(res, 415, { error: 'File type not previewable' });

  try {
    const stats = await fs.stat(safe);
    if (stats.isDirectory()) return sendJson(res, 400, { error: 'Path is a directory' });
    if (stats.size > MAX_PREVIEW_BYTES) return sendJson(res, 413, { error: 'File too large for preview' });

    const content = await fs.readFile(safe, 'utf8');
    return sendJson(res, 200, { name: path.basename(rel), content });
  } catch {
    return sendJson(res, 500, { error: 'Cannot read file' });
  }
}

async function apiDownload(req: http.IncomingMessage, res: http.ServerResponse, rel: string) {
  const safe = await resolveSafePath(rel);
  if (!safe) return sendJson(res, 403, { error: 'Invalid path' });

  try {
    const stats = await fs.stat(safe);
    if (stats.isDirectory()) return sendJson(res, 400, { error: 'Cannot download directory' });

    const filename = path.basename(rel) || 'download';
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
    });

    // Stream file (avoid buffering)
    const stream = (await import('fs')).createReadStream(safe);
    stream.on('error', () => {
      try {
        res.end();
      } catch {}
    });
    stream.pipe(res);
  } catch {
    return sendJson(res, 500, { error: 'Cannot download file' });
  }
}

export async function handleFileExplorer(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  // If auth not configured, behave as "not available"
  if (!AUTH_PASS_HASH) return false;

  // Only GET for UI + API, keep it simple and safe
  const url = getUrl(req);
  const pathname = url.pathname || '';

  if (!pathname.startsWith(BASE_PATH)) return false;

  // Require auth for everything under /admin/files
  if (!isAuthed(req)) {
    unauthorized(res);
    return true;
  }

  const subPath = stripBase(pathname); // e.g. '', 'api/list'

  // UI
  if ((subPath === '' || subPath === '/') && req.method === 'GET') {
    send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, buildUiHtml());
    return true;
  }

  // API routes
  if (subPath === 'api/list' && req.method === 'GET') {
    const rel = (url.searchParams.get('path') || '').replace(/^\/+|\/+$/g, '');
    await apiList(res, rel);
    return true;
  }

  if (subPath === 'api/preview' && req.method === 'GET') {
    const rel = (url.searchParams.get('path') || '').replace(/^\/+|\/+$/g, '');
    await apiPreview(res, rel);
    return true;
  }

  if (subPath === 'api/download' && req.method === 'GET') {
    const rel = (url.searchParams.get('path') || '').replace(/^\/+|\/+$/g, '');
    await apiDownload(req, res, rel);
    return true;
  }

  // Not a recognized file-explorer endpoint; let main server handle (likely 404)
  return false;
}

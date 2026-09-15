/* ===========================================================
   DEAD PIXEL WEB — github-api.js
   Talks directly to GitHub's REST API from the browser.
   This IS the backend — there is no server.
   =========================================================== */

const GH = (() => {
  const API_BASE = 'https://api.github.com';
  const RAW_BASE = 'https://raw.githubusercontent.com';

  function authHeaders(extra = {}) {
    return {
      Authorization: `token ${GH_CONFIG.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    };
  }

  function repoUrl(pathAndQuery = '') {
    return `${API_BASE}/repos/${GH_CONFIG.owner}/${GH_CONFIG.repo}${pathAndQuery}`;
  }

  async function request(method, pathAndQuery, body) {
    const res = await fetch(repoUrl(pathAndQuery), {
      method,
      headers: authHeaders(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      /* some responses (e.g. 204) have no body */
    }
    if (!res.ok) {
      const err = new Error((data && data.message) || `GitHub API error (HTTP ${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // ---------- issues (threads) ----------

  async function listIssues({ labels, state = 'open', per_page = 100, page = 1 } = {}) {
    const params = new URLSearchParams({ state, per_page: String(per_page), page: String(page) });
    if (labels) params.set('labels', labels);
    return request('GET', `/issues?${params.toString()}`);
  }

  async function getIssue(number) {
    return request('GET', `/issues/${number}`);
  }

  async function createIssue({ title, body, labels }) {
    return request('POST', '/issues', { title, body, labels });
  }

  async function listComments(number, per_page = 100) {
    return request('GET', `/issues/${number}/comments?per_page=${per_page}`);
  }

  async function createComment(number, body) {
    return request('POST', `/issues/${number}/comments`, { body });
  }

  // ---------- repo contents (users.json, avatar image files) ----------

  function utf8ToBase64(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }
  function base64ToUtf8(b64) {
    return decodeURIComponent(escape(atob(b64.replace(/\n/g, ''))));
  }

  // Returns { content: string, sha } or null if the file doesn't exist yet.
  async function getFile(path) {
    try {
      const data = await request('GET', `/contents/${encodeURIComponent(path)}?ref=${GH_CONFIG.branch}`);
      return { content: base64ToUtf8(data.content), sha: data.sha };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  // Like getFile, but skips the UTF-8 decode (safe to use on binary files
  // like avatars) and only returns the sha, which is all a binary write
  // needs to know whether it's creating vs. updating a file.
  async function getFileSha(path) {
    try {
      const data = await request('GET', `/contents/${encodeURIComponent(path)}?ref=${GH_CONFIG.branch}`);
      return data.sha;
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  // Writes a text file. Pass the previous `sha` when updating an existing
  // file (required by GitHub to prevent silently clobbering someone else's
  // concurrent edit); omit it when creating a new file.
  async function putTextFile(path, content, message, sha) {
    const body = { message, content: utf8ToBase64(content), branch: GH_CONFIG.branch };
    if (sha) body.sha = sha;
    return request('PUT', `/contents/${encodeURIComponent(path)}`, body);
  }

  // Writes a binary file (avatars). base64Content should already be base64
  // (e.g. from FileReader.readAsDataURL, with the "data:...;base64," prefix
  // stripped off).
  async function putBinaryFile(path, base64Content, message, sha) {
    const body = { message, content: base64Content, branch: GH_CONFIG.branch };
    if (sha) body.sha = sha;
    return request('PUT', `/contents/${encodeURIComponent(path)}`, body);
  }

  function rawUrl(path) {
    return `${RAW_BASE}/${GH_CONFIG.owner}/${GH_CONFIG.repo}/${GH_CONFIG.branch}/${path}`;
  }

  return {
    listIssues,
    getIssue,
    createIssue,
    listComments,
    createComment,
    getFile,
    getFileSha,
    putTextFile,
    putBinaryFile,
    rawUrl,
  };
})();

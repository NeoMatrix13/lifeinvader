/* ===========================================================
   DEAD PIXEL WEB — script.js
   GitHub-as-backend edition. There is no server: this file *is*
   the backend logic, running in the visitor's browser and talking
   straight to GitHub's REST API via github-api.js (loaded first).
   =========================================================== */

const CATEGORIES = [
  { slug: 'cat-general-discussion', section: 'GENERAL DISCUSSION', name: 'General Discussion', description: 'Talk about anything.' },
  { slug: 'cat-pc-games', section: 'GAMING', name: 'PC Games', description: 'PC gaming talk.' },
  { slug: 'cat-retro-games', section: 'GAMING', name: 'Retro Games', description: 'Old-school and classic gaming.' },
  { slug: 'cat-game-development', section: 'GAMING', name: 'Game Development', description: 'Making your own games.' },
  { slug: 'cat-computers', section: 'TECH', name: 'Computers', description: 'Hardware, builds, and troubleshooting.' },
  { slug: 'cat-programming', section: 'TECH', name: 'Programming', description: 'Code, languages, and dev talk.' },
  { slug: 'cat-internet', section: 'TECH', name: 'Internet', description: 'Websites, networks, and the web at large.' },
  { slug: 'cat-music', section: 'OFF-TOPIC', name: 'Music', description: 'What are you listening to?' },
  { slug: 'cat-movies', section: 'OFF-TOPIC', name: 'Movies', description: 'Film discussion.' },
  { slug: 'cat-random', section: 'OFF-TOPIC', name: 'Random', description: 'Everything else.' },
];

const SHOUTBOX_LABEL = 'shoutbox';
const SHOUTBOX_TITLE = 'DPW GUESTBOOK — do not close or delete this issue';
const USERS_PATH = 'data/users.json';
const REPLY_SCAN_LIMIT = 30; // bound how many threads we scan for a profile's "recent replies"

const DPW = (() => {
  // ---------- tiny utilities ----------

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str == null ? '' : String(str);
    return d.innerHTML;
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (isNaN(then)) return iso;
    const s = Math.floor((Date.now() - then) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' hr ago';
    if (s < 604800) return Math.floor(s / 86400) + ' day(s) ago';
    return formatDate(iso);
  }

  function qs(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  function showStatus(el, msg, kind) {
    if (!el) return;
    el.textContent = msg;
    el.className = 'status-msg ' + (kind === 'error' ? 'error' : 'ok');
    el.style.display = 'block';
  }

  function configOk() {
    return !!(GH_CONFIG.owner && GH_CONFIG.repo && GH_CONFIG.token && GH_CONFIG.token !== 'PASTE_YOUR_TOKEN_HERE');
  }

  function injectConfigWarning() {
    if (document.getElementById('dpw-config-warning')) return;
    const div = document.createElement('div');
    div.id = 'dpw-config-warning';
    div.className = 'status-msg error';
    div.style.cssText = 'display:block;margin:12px;';
    div.innerHTML =
      'ERROR: This site is not configured yet. Edit <code>client/config.js</code> and fill in your GitHub username, repo name, and a token — see the README for how to create one.';
    const page = document.getElementById('page');
    if (page) page.insertBefore(div, page.children[1] || null);
  }

  // ---------- crypto (client-side only — see README for what this does and doesn't protect against) ----------

  async function sha256Hex(str) {
    const enc = new TextEncoder().encode(str);
    const digest = await crypto.subtle.digest('SHA-256', enc);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function randomHex(bytes = 16) {
    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // ---------- post body <-> {author, message} encoding ----------
  // GitHub always shows the token-owner's account as the issue/comment
  // "author". We embed the real poster's username in a marker line so the
  // app can display who actually posted, regardless of whose token wrote it.

  const AUTHOR_MARKER_RE = /^<!--DPW-AUTHOR:([^>]*)-->\n?/;

  function wrapBody(username, message) {
    return `<!--DPW-AUTHOR:${username}-->\n${message}`;
  }

  function parseBody(raw, fallbackAuthor) {
    const m = AUTHOR_MARKER_RE.exec(raw || '');
    if (m) return { author: m[1], message: raw.slice(m[0].length) };
    return { author: fallbackAuthor || null, message: raw || '' };
  }

  // ---------- users.json store ----------

  async function loadUsersFile() {
    const file = await GH.getFile(USERS_PATH);
    if (!file) return { users: [], sha: null };
    try {
      return { users: JSON.parse(file.content), sha: file.sha };
    } catch (e) {
      return { users: [], sha: file.sha };
    }
  }

  // Applies `mutator(users)` (which returns the new array, or throws a
  // user-facing Error for validation failures) and commits it. Retries a
  // few times if someone else's commit landed in between (a 409/422 from a
  // stale `sha`) by reloading and re-applying the mutator.
  async function updateUsersFile(mutator, commitMessage) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { users, sha } = await loadUsersFile();
      const next = mutator(users);
      try {
        await GH.putTextFile(USERS_PATH, JSON.stringify(next, null, 2), commitMessage, sha);
        return next;
      } catch (e) {
        if (e.status === 409 || e.status === 422) {
          lastErr = e;
          continue;
        }
        throw e;
      }
    }
    throw lastErr || new Error('ERROR: Could not save — please try again.');
  }

  function setCurrentUsername(username) {
    localStorage.setItem('dpw_username', username);
  }
  function getCurrentUsername() {
    return localStorage.getItem('dpw_username');
  }
  function logout() {
    localStorage.removeItem('dpw_username');
  }

  function avatarUrlFor(user) {
    if (!user || !user.avatarPath) return null;
    const v = user.avatarVersion || 0;
    return GH.rawUrl(user.avatarPath) + `?v=${v}`;
  }

  function publicUser(user) {
    if (!user) return null;
    return {
      username: user.username,
      signature: user.signature || '',
      avatar_url: avatarUrlFor(user),
      created_at: user.createdAt,
    };
  }

  async function currentUser() {
    const username = getCurrentUsername();
    if (!username) return null;
    const { users } = await loadUsersFile();
    const user = users.find((u) => u.username === username);
    if (!user) {
      logout();
      return null;
    }
    return publicUser(user);
  }

  // ---------- accounts ----------

  function validateRegistration(username, password, confirmPassword) {
    if (!username || !password || !confirmPassword) return 'ERROR: All fields are required.';
    username = String(username).trim();
    if (username.length < 3 || username.length > 20) return 'ERROR: Username must be between 3 and 20 characters.';
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) return 'ERROR: Username may only contain letters, numbers, underscores, and hyphens.';
    if (String(password).length < 6) return 'ERROR: Password must be at least 6 characters.';
    if (password !== confirmPassword) return 'ERROR: Passwords do not match.';
    return null;
  }

  async function register(username, password, confirmPassword) {
    const validationError = validateRegistration(username, password, confirmPassword);
    if (validationError) throw new Error(validationError);

    username = String(username).trim();
    const salt = randomHex();
    const hash = await sha256Hex(salt + password);
    const createdAt = new Date().toISOString();

    await updateUsersFile((users) => {
      if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
        throw new Error('ERROR: That username is already taken.');
      }
      users.push({ username, salt, hash, signature: '', avatarPath: null, avatarVersion: 0, createdAt });
      return users;
    }, `Register user: ${username}`);

    setCurrentUsername(username);
    return publicUser({ username, signature: '', avatarPath: null, createdAt });
  }

  async function login(username, password) {
    if (!username || !password) throw new Error('ERROR: All fields are required.');
    username = String(username).trim();
    const { users } = await loadUsersFile();
    const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!user) throw new Error('LOGIN FAILED: Incorrect username or password.');
    const hash = await sha256Hex(user.salt + password);
    if (hash !== user.hash) throw new Error('LOGIN FAILED: Incorrect username or password.');
    setCurrentUsername(user.username);
    return publicUser(user);
  }

  async function updateSignature(signature) {
    const username = getCurrentUsername();
    if (!username) throw new Error('ERROR: You must be logged in to post.');
    const clean = String(signature || '').trim().slice(0, 200);
    await updateUsersFile((users) => {
      const u = users.find((x) => x.username === username);
      if (!u) throw new Error('ERROR: User not found.');
      u.signature = clean;
      return users;
    }, `Update signature for ${username}`);
    return clean;
  }

  async function uploadAvatar(file) {
    const username = getCurrentUsername();
    if (!username) throw new Error('ERROR: You must be logged in to post.');
    const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };
    const ext = extMap[file.type];
    if (!ext) throw new Error('ERROR: Only JPG, PNG, GIF, or WEBP images are allowed.');
    if (file.size > 2 * 1024 * 1024) throw new Error('ERROR: Image must be 2MB or smaller.');

    const path = `avatars/${username}.${ext}`;
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('ERROR: Could not read that file.'));
      r.readAsDataURL(file);
    });
    const base64 = dataUrl.split(',')[1];
    const sha = await GH.getFileSha(path);
    await GH.putBinaryFile(path, base64, `Upload avatar for ${username}`, sha);

    let avatarUrl;
    await updateUsersFile((users) => {
      const u = users.find((x) => x.username === username);
      if (!u) throw new Error('ERROR: User not found.');
      u.avatarPath = path;
      u.avatarVersion = (u.avatarVersion || 0) + 1;
      avatarUrl = avatarUrlFor(u);
      return users;
    }, `Set avatar for ${username}`);

    return avatarUrl;
  }

  async function removeAvatar() {
    const username = getCurrentUsername();
    if (!username) throw new Error('ERROR: You must be logged in to post.');
    await updateUsersFile((users) => {
      const u = users.find((x) => x.username === username);
      if (!u) throw new Error('ERROR: User not found.');
      u.avatarPath = null;
      return users;
    }, `Remove avatar for ${username}`);
  }

  // ---------- threads (GitHub Issues) ----------

  function categoryForIssue(issue) {
    const label = issue.labels.find((l) => CATEGORIES.some((c) => c.slug === l.name));
    return CATEGORIES.find((c) => c.slug === (label && label.name)) || null;
  }

  function isShoutboxIssue(issue) {
    return issue.labels.some((l) => l.name === SHOUTBOX_LABEL);
  }

  function shapeThreadSummary(issue) {
    const { author } = parseBody(issue.body, issue.user && issue.user.login);
    const cat = categoryForIssue(issue);
    return {
      id: issue.number,
      title: issue.title,
      author,
      category_slug: cat ? cat.slug : null,
      category_name: cat ? cat.name : 'Uncategorized',
      reply_count: issue.comments,
      created_at: issue.created_at,
      last_activity: issue.updated_at,
    };
  }

  async function listThreads(categorySlug) {
    const issues = await GH.listIssues({ labels: categorySlug, state: 'open', per_page: 100 });
    return issues.filter((i) => !isShoutboxIssue(i)).map(shapeThreadSummary);
  }

  async function createThread(categorySlug, title, message) {
    const username = getCurrentUsername();
    if (!username) throw new Error('ERROR: You must be logged in to post.');
    title = String(title || '').trim().slice(0, 140);
    message = String(message || '').trim().slice(0, 8000);
    if (!title || !message) throw new Error('ERROR: Title and message cannot be empty.');
    const issue = await GH.createIssue({ title, body: wrapBody(username, message), labels: [categorySlug] });
    return issue.number;
  }

  async function getThread(number) {
    const issue = await GH.getIssue(number);
    const op = parseBody(issue.body, issue.user && issue.user.login);
    const cat = categoryForIssue(issue);
    const { users } = await loadUsersFile();
    const opUser = users.find((u) => u.username === op.author);

    const rawComments = await GH.listComments(number, 100);
    const replies = rawComments.map((c) => {
      const parsed = parseBody(c.body, c.user && c.user.login);
      const u = users.find((x) => x.username === parsed.author);
      return {
        id: c.id,
        author: parsed.author,
        message: parsed.message,
        created_at: c.created_at,
        author_signature: u ? u.signature : '',
        author_avatar: avatarUrlFor(u),
        author_joined: u ? u.createdAt : null,
      };
    });

    const thread = {
      id: issue.number,
      title: issue.title,
      message: op.message,
      category_name: cat ? cat.name : 'Uncategorized',
      author: op.author,
      author_signature: opUser ? opUser.signature : '',
      author_avatar: avatarUrlFor(opUser),
      author_joined: opUser ? opUser.createdAt : null,
      created_at: issue.created_at,
    };

    return { thread, replies };
  }

  async function createReply(number, message) {
    const username = getCurrentUsername();
    if (!username) throw new Error('ERROR: You must be logged in to post.');
    message = String(message || '').trim().slice(0, 8000);
    if (!message) throw new Error('ERROR: Message cannot be empty.');
    await GH.createComment(number, wrapBody(username, message));
  }

  // ---------- categories, with per-category stats ----------

  async function getCategoriesWithStats() {
    const results = [];
    for (const cat of CATEGORIES) {
      const issues = await GH.listIssues({ labels: cat.slug, state: 'open', per_page: 100 });
      let lastThread = null;
      if (issues.length) {
        const top = [...issues].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0];
        const parsed = parseBody(top.body, top.user && top.user.login);
        lastThread = { title: top.title, username: parsed.author, created_at: top.updated_at };
      }
      results.push({ ...cat, threadCount: issues.length, lastThread });
    }
    return results;
  }

  // ---------- shoutbox / guestbook ----------

  let shoutboxIssueNumberCache = null;

  async function getOrCreateShoutboxIssue() {
    if (shoutboxIssueNumberCache) return shoutboxIssueNumberCache;
    const found = await GH.listIssues({ labels: SHOUTBOX_LABEL, state: 'all', per_page: 1 });
    if (found.length) {
      shoutboxIssueNumberCache = found[0].number;
      return shoutboxIssueNumberCache;
    }
    const created = await GH.createIssue({
      title: SHOUTBOX_TITLE,
      body: "This issue powers the homepage shoutbox/guestbook — comments posted here show up on the site. Please don't close or delete it.",
      labels: [SHOUTBOX_LABEL],
    });
    shoutboxIssueNumberCache = created.number;
    return shoutboxIssueNumberCache;
  }

  async function listShouts() {
    const number = await getOrCreateShoutboxIssue();
    const comments = await GH.listComments(number, 30);
    return comments
      .slice(-10)
      .reverse()
      .map((c) => {
        const parsed = parseBody(c.body, c.user && c.user.login);
        return { id: c.id, username: parsed.author, message: parsed.message, created_at: c.created_at };
      });
  }

  async function postShout(message) {
    const username = getCurrentUsername();
    if (!username) throw new Error('ERROR: You must be logged in to post.');
    message = String(message || '').trim().slice(0, 500);
    if (!message) throw new Error('ERROR: Message cannot be empty.');
    const number = await getOrCreateShoutboxIssue();
    await GH.createComment(number, wrapBody(username, message));
  }

  // ---------- homepage stats & member list ----------

  async function getStats() {
    const { users } = await loadUsersFile();
    const issues = await GH.listIssues({ state: 'open', per_page: 100 });
    const threads = issues.filter((i) => !isShoutboxIssue(i));
    const replyCount = threads.reduce((sum, i) => sum + i.comments, 0);
    return { memberCount: users.length, threadCount: threads.length, replyCount };
  }

  async function getLatestMembers(n = 8) {
    const { users } = await loadUsersFile();
    return [...users]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, n)
      .map((u) => ({ username: u.username, created_at: u.createdAt, avatar_url: avatarUrlFor(u) }));
  }

  // ---------- profile ----------

  async function getProfile(username) {
    const { users } = await loadUsersFile();
    const user = users.find((u) => u.username === username);
    if (!user) throw new Error('ERROR 404: PAGE NOT FOUND');

    const issues = await GH.listIssues({ state: 'open', per_page: 100 });
    const threads = issues.filter((i) => !isShoutboxIssue(i));
    const userThreads = threads.filter((i) => parseBody(i.body, i.user && i.user.login).author === username);

    // Scanning every thread's comments for "replies by this user" doesn't
    // scale without a real backend, so this only looks at the most
    // recently active threads. Good enough for a small forum; the reply
    // *count* shown will undercount once a forum has more than
    // REPLY_SCAN_LIMIT active threads.
    const scanThreads = [...threads].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, REPLY_SCAN_LIMIT);
    let replyCount = 0;
    const recentReplies = [];
    for (const t of scanThreads) {
      if (t.comments === 0) continue;
      const comments = await GH.listComments(t.number, 100);
      for (const c of comments) {
        const parsed = parseBody(c.body, c.user && c.user.login);
        if (parsed.author === username) {
          replyCount++;
          recentReplies.push({ id: c.id, message: parsed.message, created_at: c.created_at, thread_id: t.number, thread_title: t.title });
        }
      }
    }
    recentReplies.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const shoutNumber = await getOrCreateShoutboxIssue();
    const shoutComments = await GH.listComments(shoutNumber, 100);
    const shoutCount = shoutComments.filter((c) => parseBody(c.body, c.user && c.user.login).author === username).length;

    return {
      user: publicUser(user),
      threadCount: userThreads.length,
      replyCount,
      postCount: userThreads.length + replyCount + shoutCount,
      recentThreads: userThreads
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 5)
        .map((t) => ({ id: t.number, title: t.title, created_at: t.created_at })),
      recentReplies: recentReplies.slice(0, 5),
      scanLimited: threads.length > REPLY_SCAN_LIMIT,
    };
  }

  // ---------- page chrome (nav highlighting, login/logout links) ----------

  async function initChrome(activePage) {
    if (!configOk()) injectConfigWarning();

    document.querySelectorAll('.nav-bar a[data-page]').forEach((a) => {
      if (a.getAttribute('data-page') === activePage) a.classList.add('current');
    });

    let user = null;
    try {
      user = await currentUser();
    } catch (e) {
      /* leave user as null; page-level code will show its own error if needed */
    }

    const authArea = document.getElementById('nav-auth-area');
    if (authArea) {
      if (user) {
        authArea.innerHTML = `
          <a href="profile.html?u=${encodeURIComponent(user.username)}" data-page="profile">Profile</a>
          <a href="#" id="logout-link">Logout</a>
        `;
        const logoutLink = document.getElementById('logout-link');
        if (logoutLink) {
          logoutLink.addEventListener('click', (e) => {
            e.preventDefault();
            logout();
            window.location.href = 'index.html';
          });
        }
      } else {
        authArea.innerHTML = `
          <a href="login.html" data-page="login">Login</a>
          <a href="register.html" data-page="register">Register</a>
        `;
      }
    }

    const whoBox = document.getElementById('logged-in-as');
    if (whoBox) {
      whoBox.textContent = user ? `Logged in as ${user.username}` : 'Not logged in — browsing as a guest';
    }

    return user;
  }

  return {
    // utilities
    escapeHtml,
    formatDate,
    timeAgo,
    qs,
    showStatus,
    configOk,
    // accounts
    register,
    login,
    logout,
    currentUser,
    updateSignature,
    uploadAvatar,
    removeAvatar,
    // forum
    CATEGORIES,
    listThreads,
    createThread,
    getThread,
    createReply,
    getCategoriesWithStats,
    // shoutbox
    listShouts,
    postShout,
    // homepage / profile
    getStats,
    getLatestMembers,
    getProfile,
    // chrome
    initChrome,
  };
})();

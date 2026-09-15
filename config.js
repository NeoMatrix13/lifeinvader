// config.js
// Fill these in to connect the site to your GitHub repo. See the README
// section "Hosting it online (GitHub-as-backend edition)" for how to create
// the token.
//
// IMPORTANT: this token will be visible to anyone who views this site's
// source — that's inherent to running a backend-free static site this way.
// Create a token scoped to ONLY this one repository, with ONLY "Issues"
// and "Contents" permissions (read and write), so the worst case if it's
// misused is limited to this repo, not your whole GitHub account.

const GH_CONFIG = {
  owner: "NeoMatrix13",   // e.g. "hellb"
  repo: "lifeinvader",          // e.g. "dead-pixel-web"
  branch: "main",                  // the branch GitHub Pages / your repo uses
  token: "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",  // a fine-grained token, scoped to this repo only
};

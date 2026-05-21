/* MediaStudio landing page — fetch latest GitHub Release and wire download buttons.
 * Set REPO to your GitHub repo once it's created (#5). Until then the buttons
 * fall back to the releases page. */
(function () {
  'use strict';

  // TODO(#5): replace with the real repo, e.g. 'youruser/mediastudio'
  const REPO = 'cenxialiu7-cloud/mediastudio';
  const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
  const API = `https://api.github.com/repos/${REPO}/releases/latest`;

  const els = {
    macArm:    document.getElementById('dl-mac-arm'),
    macArmSub: document.getElementById('dl-mac-arm-sub'),
    macIntel:  document.getElementById('dl-mac-intel'),
    win:       document.getElementById('dl-win'),
    winSub:    document.getElementById('dl-win-sub'),
    note:      document.getElementById('version-note'),
  };

  // Default every button to the releases page (works even if API fails / repo private)
  [els.macArm, els.macIntel, els.win].forEach((a) => { if (a) a.href = RELEASES_PAGE; });

  // Match release asset names to the right button.
  // MediaStudio artifacts: MediaStudio-<ver>-arm64.dmg / -x64.dmg, MediaStudio-Setup-<ver>.exe
  function classify(name) {
    const n = name.toLowerCase();
    if (n.endsWith('.exe')) return 'win';
    if (n.endsWith('.dmg') && (n.includes('arm64') || n.includes('arm') || n.includes('apple') || n.includes('aarch64'))) return 'macArm';
    if (n.endsWith('.dmg') && (n.includes('x64') || n.includes('intel') || n.includes('x86'))) return 'macIntel';
    if (n.endsWith('.dmg')) return 'macArm'; // default any .dmg to arm
    return null;
  }

  fetch(API, { headers: { Accept: 'application/vnd.github+json' } })
    .then((r) => { if (!r.ok) throw new Error(`GitHub API ${r.status}`); return r.json(); })
    .then((release) => {
      const version = release.tag_name || release.name || '';
      const assets = release.assets || [];
      let found = { win: false, macArm: false, macIntel: false };

      assets.forEach((asset) => {
        const kind = classify(asset.name);
        if (!kind) return;
        const url = asset.browser_download_url;
        if (kind === 'win' && els.win) { els.win.href = url; found.win = true; }
        if (kind === 'macArm' && els.macArm) { els.macArm.href = url; found.macArm = true; }
        if (kind === 'macIntel' && els.macIntel) { els.macIntel.href = url; found.macIntel = true; }
      });

      if (!found.macIntel && els.macIntel) els.macIntel.style.display = 'none';

      if (els.note) els.note.textContent = version ? `最新版本 Latest: ${version}` : '';
    })
    .catch(() => {
      if (els.note) {
        els.note.innerHTML = `前往 <a href="${RELEASES_PAGE}" rel="noopener">GitHub Releases 頁面</a> 下載最新版本`;
      }
    });
})();

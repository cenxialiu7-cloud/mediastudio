// electron-builder afterPack hook (CommonJS).
//
// electron-builder's default ad-hoc sign (when identity:null) runs DURING pack,
// BEFORE our extraResources (ms-app + node_modules) and resources/bin are all
// finalized — leaving an INVALID seal ("code has no resources but signature
// indicates they must be present"). On a user's machine that broken signature
// triggers the scary "MediaStudio is damaged — move to Trash" error.
//
// Fix: after the app bundle is fully assembled, re-apply a VALID ad-hoc deep
// signature covering everything. Users still see the milder "unidentified
// developer" prompt (unavoidable without paid notarization), but never the
// "damaged" error. arm64 also REQUIRES a valid signature to launch at all.
const path = require('node:path');
const { execFileSync } = require('node:child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename; // "MediaStudio"
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`[afterPack] ad-hoc deep re-sign → ${appPath}`);
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    // Sanity-check the seal so a broken build fails loudly instead of shipping.
    execFileSync('codesign', ['--verify', '--verbose', appPath], { stdio: 'inherit' });
    console.log('[afterPack] signature valid ✓');
  } catch (e) {
    throw new Error(`afterPack ad-hoc sign failed: ${e.message}`);
  }
};

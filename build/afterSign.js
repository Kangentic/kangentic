const path = require('path');
const { verifyPackagedSpawnHelpers } = require('./install-spawn-helper');

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const productFilename = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${productFilename}.app`);

  // afterPack proved the spawn-helper clears the inherited exception ports
  // before signing. Prove it again on the SIGNED binary, since hardened runtime
  // is the one thing signing adds. electron-builder calls this hook only when
  // it signed (an unsigned build logs `skipping "afterSign" hook`), so this runs
  // on the release leg and on any local build with a signing identity, before
  // the notarization skip below. Throws on failure; see
  // build/install-spawn-helper.js.
  verifyPackagedSpawnHelpers({
    unpackedRoot: path.join(appPath, 'Contents', 'Resources', 'app.asar.unpacked'),
  });

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.log('[afterSign] Skipping notarization: APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not all set (dev build).');
    return;
  }

  console.log(`[afterSign] Notarizing ${appPath} with notarytool...`);
  const start = Date.now();
  // @electron/notarize v3 is ESM-only; load it dynamically so this CommonJS
  // electron-builder hook can consume it on Node 22.12+ regardless of host.
  const { notarize } = await import('@electron/notarize');
  await notarize({
    tool: 'notarytool',
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });
  const elapsedSeconds = Math.round((Date.now() - start) / 1000);
  console.log(`[afterSign] Notarized in ${elapsedSeconds}s`);
};

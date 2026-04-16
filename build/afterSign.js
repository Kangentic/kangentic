const path = require('path');
const { notarize } = require('@electron/notarize');

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.log('[afterSign] Skipping notarization: APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not all set (dev build).');
    return;
  }

  const productFilename = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${productFilename}.app`);

  console.log(`[afterSign] Notarizing ${appPath} with notarytool...`);
  const start = Date.now();
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

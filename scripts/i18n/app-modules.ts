// What the translation harness takes from the app and its test helpers. They are
// TypeScript with extensionless imports, so scripts/i18n/cli.mjs bundles
// this entry with scripts/lib/bundle-ts-module.mjs rather than importing them.

// The width table the app's terminals use, East Asian wide characters at two columns.
export { wcwidthV11 } from '../../src/shared/xterm-unicode11';
// The descriptions settings cards show, and the one-line budget each has.
export { DESCRIPTION_BUDGET, scanRealSettings } from '../../tests/unit/helpers/settings-card-scan';

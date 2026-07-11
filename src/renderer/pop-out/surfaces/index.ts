import { registerSurface } from '../surface-registry';
import { statsSurface } from './stats-surface';
import { changesSurface } from './changes-surface';
import { browserSurface } from './browser-surface';

// Side-effect registration: importing this module (once, from PopOutSurfaceRoot)
// populates the surface registry before any pop-out window's getSurface() call.
registerSurface(statsSurface);
registerSurface(changesSurface);
registerSurface(browserSurface);

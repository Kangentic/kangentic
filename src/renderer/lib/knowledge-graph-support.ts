/**
 * Whether the Knowledge Graph can run in this build, and its effective switch.
 *
 * Its local model has no build for every platform (`src/shared/embedding-runtime.ts`:
 * none for Intel Macs), and main never runs it there whatever the config says.
 * So every renderer reader of `knowledgeGraph.enabled` goes through
 * `knowledgeGraphOn`, never the raw value: a config holding `enabled: true` on
 * such a machine (written by hand, or copied from another one) would otherwise
 * show the Settings card's rows and the Index's lines waiting on a model that
 * can never load.
 */

import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { embeddingRuntimeGapName, isEmbeddingRuntimeSupported } from '../../shared/embedding-runtime';
import { translateText } from '../i18n/translate';
import type { AppConfig } from '../../shared/types';

/** The tag the Knowledge Graph card, the map's stand-in card and the Index
 *  lines that need the model all carry where it cannot run. The English
 *  constant stays for callers not yet switched to `knowledgeGraphUnavailableTag`. */
export const KNOWLEDGE_GRAPH_UNAVAILABLE_TAG = 'Unavailable';

/** `KNOWLEDGE_GRAPH_UNAVAILABLE_TAG` in the session's language, read where it renders. */
export function knowledgeGraphUnavailableTag(): string {
  return i18n._(msg`Unavailable`);
}

/** Whether this build's platform and arch can load the local model. */
export function knowledgeGraphSupported(): boolean {
  return isEmbeddingRuntimeSupported(window.electronAPI.platform, window.electronAPI.arch);
}

/** The Knowledge Graph is on: switched on in config, in a build that can run it. */
export function knowledgeGraphOn(config: AppConfig['knowledgeGraph'] | undefined): boolean {
  return config?.enabled === true && knowledgeGraphSupported();
}

/** The sentence that says why it cannot run here. */
export function knowledgeGraphUnsupportedLine(): string {
  const platformName = translateText(embeddingRuntimeGapName(window.electronAPI.platform, window.electronAPI.arch));
  return i18n._(msg`The local model does not run on ${{ platformName }}.`);
}

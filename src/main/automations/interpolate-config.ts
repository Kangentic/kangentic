import { applyTemplateEscape } from '../../shared/template-escape';
import type { AutomationField } from '../../shared/automation-manifest';
import type { AutomationConfig } from '../../shared/types';
import { interpolateTemplate } from '../agent/shared/template-utils';

/**
 * Substitute every template variable in an automation's config, applying each
 * FIELD's own escape.
 *
 * The runner does this once, before handing the config to the adapter, which is
 * the whole reason an adapter never sees a `{{variable}}`. Two things fall out
 * of putting it here rather than in each adapter: escaping cannot be forgotten
 * by a new type, and a field that should not be escaped has to say so in the
 * manifest, where a test can read it.
 *
 * Only fields the manifest marks `templateVariables` are touched. A `method`
 * select or a `headers` block is left exactly as written.
 */
export function interpolateAutomationConfig(
  config: AutomationConfig,
  fields: readonly AutomationField[],
  variables: Record<string, string>,
): AutomationConfig {
  const next: AutomationConfig = { ...config };

  for (const field of fields) {
    if (field.templateVariables !== true) continue;

    const raw = (next as Record<string, unknown>)[field.key];
    if (typeof raw !== 'string' || raw.length === 0) continue;

    // Escape each VALUE as it is substituted, never the finished string: a
    // template's own punctuation is the author's and must survive, while the
    // value dropped into it is the untrusted half.
    const escaped: Record<string, string> = {};
    for (const [name, value] of Object.entries(variables)) {
      escaped[name] = applyTemplateEscape(value, field.escape);
    }

    (next as Record<string, unknown>)[field.key] = interpolateTemplate(raw, escaped);
  }

  return next;
}

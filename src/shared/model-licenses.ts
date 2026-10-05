/**
 * The licenses the downloadable local models ship under: dictation
 * (`src/main/transcription/models/model-registry.ts`) and the Knowledge Graph's
 * embedding models (`embedding-models.ts`). Each model names its license by id,
 * and the Dictation and Knowledge Graph settings tabs show the name with a link
 * to the license text.
 *
 * The app downloads weights from Hugging Face at the user's request and does
 * not redistribute them, but the link is how a user reads the terms they are
 * downloading under. A new license needs its entry here before a model can
 * name it, which the type enforces.
 */
export type ModelLicenseId =
  | 'Apache-2.0'
  | 'MIT'
  | 'CC-BY-4.0'
  | 'NVIDIA-Open-Model-License'
  | 'OpenMDW-1.1';

export interface ModelLicense {
  /** The name the settings tabs show. */
  name: string;
  /** The license text. */
  url: string;
}

export const MODEL_LICENSES: Readonly<Record<ModelLicenseId, ModelLicense>> = {
  'Apache-2.0': { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
  MIT: { name: 'MIT', url: 'https://opensource.org/license/mit' },
  'CC-BY-4.0': { name: 'CC-BY-4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
  // NVIDIA asks redistributors to carry the notice "Licensed by NVIDIA
  // Corporation under the NVIDIA Open Model License" (docs/configuration.md).
  'NVIDIA-Open-Model-License': {
    name: 'NVIDIA Open Model License',
    url: 'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/',
  },
  'OpenMDW-1.1': { name: 'OpenMDW-1.1', url: 'https://openmdw.ai/license/1-1/' },
};

/** The distinct licenses of a set of models, in first-seen order, as the links
 *  a settings License line shows. */
export function licenseLinks(licenseIds: readonly ModelLicenseId[]): Array<{ label: string; href: string }> {
  return [...new Set(licenseIds)].map((licenseId) => ({
    label: MODEL_LICENSES[licenseId].name,
    href: MODEL_LICENSES[licenseId].url,
  }));
}

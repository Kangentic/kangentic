import { describe, it, expect } from 'vitest';
import { MODEL_LICENSES, licenseLinks } from '../../src/shared/model-licenses';

/**
 * The links the Dictation and Knowledge Graph tabs show on their License line.
 * One link per DISTINCT license, in the order the models list them, so two models
 * under the same license do not repeat it.
 */
describe('licenseLinks', () => {
  it('gives two models that share a license one link', () => {
    expect(licenseLinks(['MIT', 'MIT'])).toEqual([
      { label: MODEL_LICENSES.MIT.name, href: MODEL_LICENSES.MIT.url },
    ]);
  });

  it('lists the licenses in first-seen order, not sorted or in table order', () => {
    // MIT before Apache-2.0 is neither alphabetical nor the order of MODEL_LICENSES.
    const links = licenseLinks(['MIT', 'Apache-2.0', 'MIT', 'CC-BY-4.0', 'Apache-2.0']);

    expect(links.map((link) => link.href)).toEqual([
      MODEL_LICENSES.MIT.url,
      MODEL_LICENSES['Apache-2.0'].url,
      MODEL_LICENSES['CC-BY-4.0'].url,
    ]);
  });

  it('labels each link with the license name and points it at the license text', () => {
    const [link] = licenseLinks(['NVIDIA-Open-Model-License']);

    expect(link).toEqual({
      label: MODEL_LICENSES['NVIDIA-Open-Model-License'].name,
      href: MODEL_LICENSES['NVIDIA-Open-Model-License'].url,
    });
    // This one's name is not its id, so a link labeled with the id would differ.
    expect(link.label).not.toBe('NVIDIA-Open-Model-License');
    expect(link.href).toMatch(/^https:\/\//);
  });

  it('gives no links for no models', () => {
    expect(licenseLinks([])).toEqual([]);
  });
});

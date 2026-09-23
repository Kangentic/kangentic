/**
 * The sample install's answer to `dictation.getInfo` must name real models.
 *
 * The mock bridge's own answer has empty model lists, so both model rows on the Dictation tab read
 * None whatever the config says. That is the "a mock that answers with nothing is not parity" shape
 * from .claude/rules/web-demo-parity.md: every structural check passes while the feature looks
 * switched off in every figure. The dataset now builds the answer with main's own
 * `buildDictationInfo`, and this pins what that answer has to carry for the Dictation tab to show
 * dictation working (demo/README.md, Dictation).
 */
import { describe, expect, it } from 'vitest';
import { DEMO_DICTATION_INFO } from '../captures/helpers/demo-dataset';

describe('the sample install answers dictation.getInfo with real models', () => {
  it('resolves both a live model and a refinement model for the default config', () => {
    // A machine on the streaming-tiny tier selects no refinement model at all, so the Refinement
    // row would read None again. The seeded profile has to stay on the accurate tier.
    expect(DEMO_DICTATION_INFO.tier).toBe('accurate-base');
    expect(DEMO_DICTATION_INFO.selectedLiveModelId).not.toBeNull();
    expect(DEMO_DICTATION_INFO.selectedFinalModelId).not.toBeNull();
  });

  it('offers each selected model in the dropdown that shows it', () => {
    const liveIds = DEMO_DICTATION_INFO.liveModels.map((model) => model.id);
    const finalIds = DEMO_DICTATION_INFO.finalModels.map((model) => model.id);
    // A select whose value has no matching option shows its first option instead, which is None.
    expect(liveIds).toContain(DEMO_DICTATION_INFO.selectedLiveModelId);
    expect(finalIds).toContain(DEMO_DICTATION_INFO.selectedFinalModelId);
  });

  it('reports both selected models as cached, so the status row reads Ready', () => {
    expect(DEMO_DICTATION_INFO.installedModels).toEqual(
      expect.arrayContaining([DEMO_DICTATION_INFO.selectedLiveModelId, DEMO_DICTATION_INFO.selectedFinalModelId]),
    );
    expect(DEMO_DICTATION_INFO.installedModels).toContain(DEMO_DICTATION_INFO.selectedModelId);
  });
});

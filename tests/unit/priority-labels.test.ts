import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { compileMessage } from '@lingui/message-utils/compileMessage';
import { displayPriorityLabel, storedPriorityLabel } from '../../src/renderer/components/backlog/priority-labels';
import { DEFAULT_PRIORITY_CONFIG } from '../../src/shared/types';

/**
 * A French-flavoured catalog for the priority messages. The descriptors built here
 * carry the same message and context as the module's, so their ids are the ones the
 * module looks up.
 */
function activateFrench(): void {
  const translations: Array<[ReturnType<typeof msg>, string]> = [
    [msg({ message: 'None', context: 'priority' }), 'Aucune'],
    [msg({ message: 'Low', context: 'priority' }), 'Basse'],
    [msg({ message: 'Medium', context: 'priority' }), 'Moyenne'],
    [msg({ message: 'High', context: 'priority' }), 'Haute'],
    [msg({ message: 'Urgent', context: 'priority' }), 'Urgente'],
    [msg({ message: 'Priority {number}', context: 'priority' }), 'Priorite n° {number}'],
  ];
  const messages: Record<string, ReturnType<typeof compileMessage>> = {};
  for (const [descriptor, translation] of translations) {
    messages[descriptor.id ?? ''] = compileMessage(translation);
  }
  i18n.loadAndActivate({ locale: 'fr', messages });
}

describe('priority labels', () => {
  afterEach(() => {
    i18n.activate('en');
  });

  describe('in English', () => {
    it('shows every seeded default as stored', () => {
      for (const priority of DEFAULT_PRIORITY_CONFIG) {
        expect(displayPriorityLabel(priority.label)).toBe(priority.label);
      }
    });

    it('shows a generated "Priority N" as stored', () => {
      expect(displayPriorityLabel('Priority 5')).toBe('Priority 5');
      expect(displayPriorityLabel('Priority 12')).toBe('Priority 12');
    });

    it('leaves a name the user typed untouched', () => {
      expect(displayPriorityLabel('Blocker')).toBe('Blocker');
      expect(displayPriorityLabel('low')).toBe('low');
      expect(displayPriorityLabel('Low ')).toBe('Low ');
      expect(displayPriorityLabel('Priority')).toBe('Priority');
      expect(displayPriorityLabel('Priority 3 extra')).toBe('Priority 3 extra');
      expect(displayPriorityLabel('')).toBe('');
    });

    it('saves what was typed unchanged', () => {
      for (const priority of DEFAULT_PRIORITY_CONFIG) {
        expect(storedPriorityLabel(priority.label)).toBe(priority.label);
      }
      expect(storedPriorityLabel('Priority 7')).toBe('Priority 7');
      expect(storedPriorityLabel('Blocker')).toBe('Blocker');
    });
  });

  describe('in another language', () => {
    it('translates the seeded defaults and the numbered name on display', () => {
      activateFrench();
      expect(displayPriorityLabel('None')).toBe('Aucune');
      expect(displayPriorityLabel('Low')).toBe('Basse');
      expect(displayPriorityLabel('Urgent')).toBe('Urgente');
      expect(displayPriorityLabel('Priority 5')).toBe('Priorite n° 5');
    });

    it('shows a name the user typed as typed, even one that matches a default in another case', () => {
      activateFrench();
      expect(displayPriorityLabel('Bloquant')).toBe('Bloquant');
      expect(displayPriorityLabel('low')).toBe('low');
      expect(displayPriorityLabel('Priority 3 extra')).toBe('Priority 3 extra');
    });

    it('maps a translated default back to English on save', () => {
      activateFrench();
      expect(storedPriorityLabel('Basse')).toBe('Low');
      expect(storedPriorityLabel('Urgente')).toBe('Urgent');
      expect(storedPriorityLabel('Priorite n° 9')).toBe('Priority 9');
    });

    it('leaves a user-typed name alone on save', () => {
      activateFrench();
      expect(storedPriorityLabel('Bloquant')).toBe('Bloquant');
      expect(storedPriorityLabel('Priorite n° ')).toBe('Priorite n° ');
      expect(storedPriorityLabel('Priorite n° 9 bis')).toBe('Priorite n° 9 bis');
    });

    it('round-trips every stored default through display and save', () => {
      activateFrench();
      for (const priority of DEFAULT_PRIORITY_CONFIG) {
        expect(storedPriorityLabel(displayPriorityLabel(priority.label))).toBe(priority.label);
      }
      expect(storedPriorityLabel(displayPriorityLabel('Priority 11'))).toBe('Priority 11');
    });
  });
});

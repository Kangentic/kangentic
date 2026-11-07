import { useRef, useState } from 'react';
import type { SshConfigHost } from '../../shared/types';
import { INPUT_CLASS } from './settings/shared';
import { useSuggestionMenu } from '../hooks/useSuggestionMenu';
import { SuggestionMenu, SuggestionOption } from './SuggestionMenu';
import { describeConfigHost, matchingConfigHosts } from './host-address';

/**
 * The address field of Add host and of a host's edit form (#913). It suggests the names in the user's
 * `~/.ssh/config` as they type, since a name from that file is already something `ssh` resolves. A suggestion
 * fills the field and nothing else: the address stays whatever the field holds.
 */
export function HostAddressInput({ value, onChange, onEnter, onKeyDown, suggestions, placeholder, testId, autoFocus }: {
  value: string;
  onChange: (value: string) => void;
  /** Enter with no suggestion highlighted: the form's own next step. */
  onEnter?: () => void;
  /** Any other key, for a form that handles Escape. */
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  suggestions: SshConfigHost[];
  placeholder?: string;
  testId: string;
  autoFocus?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  /** Escape closed the menu. The next keystroke opens it again. */
  const [menuClosed, setMenuClosed] = useState(false);
  const matches = matchingConfigHosts(suggestions, value);
  const open = focused && !menuClosed && matches.length > 0;
  const wrapRef = useRef<HTMLDivElement>(null);
  const menu = useSuggestionMenu({
    anchorRef: wrapRef,
    itemCount: matches.length,
    open,
    onChoose: (index) => onChange(matches[index].alias),
    onDismiss: () => setMenuClosed(true),
    onReopen: () => setMenuClosed(false),
  });

  return (
    <div ref={wrapRef}>
      <input
        type="text"
        autoFocus={autoFocus}
        className={`${INPUT_CLASS} font-mono`}
        value={value}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        data-testid={testId}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(event) => {
          onChange(event.target.value);
          menu.setHighlight(-1);
          setMenuClosed(false);
        }}
        onKeyDown={(event) => {
          if (menu.handleMenuKey(event)) return;
          if (event.key === 'Enter') onEnter?.();
          else onKeyDown?.(event);
        }}
      />
      <SuggestionMenu menu={menu} open={open} testId={`${testId}-suggestions`}>
        {matches.map((host, index) => (
          <SuggestionOption
            key={host.alias}
            selected={index === menu.highlight}
            onChoose={() => {
              onChange(host.alias);
              menu.setHighlight(-1);
            }}
            testId={`${testId}-suggestion`}
          >
            <span className="min-w-0 truncate">{host.alias}</span>
            <span className="min-w-0 truncate text-xs text-fg-faint">{describeConfigHost(host)}</span>
          </SuggestionOption>
        ))}
      </SuggestionMenu>
    </div>
  );
}

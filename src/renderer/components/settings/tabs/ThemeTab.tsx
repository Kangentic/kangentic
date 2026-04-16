import type { AppConfig, ThemeMode } from '../../../../shared/types';
import { NAMED_THEMES } from '../../../../shared/types';
import { SettingRow, Select, useScopedUpdate } from '../shared';
import { settingProps } from '../settings-registry';

export function ThemeTab({ config }: { config: AppConfig }) {
  const updateProject = useScopedUpdate('project');
  return (
    <SettingRow {...settingProps('theme')}>
      <Select
        value={config.theme}
        onChange={(event) => updateProject({ theme: event.target.value as ThemeMode })}
      >
        <optgroup label="Standard">
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </optgroup>
        <optgroup label="Dark Palette">
          {NAMED_THEMES.filter(theme => theme.base === 'dark').map(theme => (
            <option key={theme.id} value={theme.id}>{theme.label}</option>
          ))}
        </optgroup>
        <optgroup label="Light Palette">
          {NAMED_THEMES.filter(theme => theme.base === 'light').map(theme => (
            <option key={theme.id} value={theme.id}>{theme.label}</option>
          ))}
        </optgroup>
      </Select>
    </SettingRow>
  );
}

import type { SshConfigHost } from '../../shared/types';

/** The most names the address field offers at once. */
export const MAX_SUGGESTED_HOSTS = 8;

/** The names from the user's SSH config that contain what is typed, other than what is already typed in full. */
export function matchingConfigHosts(hosts: SshConfigHost[], typed: string): SshConfigHost[] {
  const wanted = typed.trim().toLowerCase();
  if (wanted.length === 0) return [];
  return hosts
    .filter((host) => host.alias.toLowerCase().includes(wanted) && host.alias.toLowerCase() !== wanted)
    .slice(0, MAX_SUGGESTED_HOSTS);
}

/** What a suggestion says beside its name: the machine and user the SSH config gives it, when it gives them. */
export function describeConfigHost(host: SshConfigHost): string {
  if (host.hostName === null) return host.user === null ? '' : `${host.user}@`;
  return host.user === null ? host.hostName : `${host.user}@${host.hostName}`;
}

/**
 * Which SSH config names the Add host address field suggests (#913). What a user loses if it breaks: a name
 * offered after it was typed in full, or a field that lists every host before anything is typed and covers
 * the buttons below it.
 */
import { describe, expect, it } from 'vitest';
import { describeConfigHost, matchingConfigHosts, MAX_SUGGESTED_HOSTS } from '../../src/renderer/components/host-address';

const hosts = [
  { alias: 'build-box', hostName: 'build.example.com', user: 'dev' },
  { alias: 'Build-Staging', hostName: null, user: null },
  { alias: 'gpu-rig', hostName: 'gpu.example.com', user: null },
];

describe('matchingConfigHosts', () => {
  it('suggests nothing before anything is typed', () => {
    expect(matchingConfigHosts(hosts, '')).toEqual([]);
    expect(matchingConfigHosts(hosts, '   ')).toEqual([]);
  });

  it('suggests the names that contain what is typed, ignoring case', () => {
    expect(matchingConfigHosts(hosts, 'build').map((host) => host.alias)).toEqual(['build-box', 'Build-Staging']);
    expect(matchingConfigHosts(hosts, 'RIG').map((host) => host.alias)).toEqual(['gpu-rig']);
  });

  it('does not suggest a name already typed in full, or a name that is not there', () => {
    expect(matchingConfigHosts(hosts, 'gpu-rig')).toEqual([]);
    expect(matchingConfigHosts(hosts, 'dev@build.example.test')).toEqual([]);
  });

  it('offers no more than the most it shows', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ alias: `node-${index}`, hostName: null, user: null }));
    expect(matchingConfigHosts(many, 'node')).toHaveLength(MAX_SUGGESTED_HOSTS);
  });
});

describe('describeConfigHost', () => {
  it('says the user and machine the config gives, and nothing when it gives neither', () => {
    expect(describeConfigHost(hosts[0])).toBe('dev@build.example.com');
    expect(describeConfigHost(hosts[2])).toBe('gpu.example.com');
    expect(describeConfigHost(hosts[1])).toBe('');
    expect(describeConfigHost({ alias: 'a', hostName: null, user: 'ops' })).toBe('ops@');
  });
});

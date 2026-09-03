import { describe, expect, it } from 'vitest';
import { groupSensors } from './sensors';

describe('groupSensors', () => {
  const temps = {
    'coretemp.Package id 0': 39,
    'coretemp.Core 0': 34,
    'coretemp.Core 1': 38,
    'coretemp.Core 2': 36,
    'nvme.Composite': 44.9,
    'nvme.Sensor 1': 44.9,
    'nvme.Sensor 2': 41.9,
    'iwlwifi_1.temp1': 31,
  };

  /**
   * A CPU reports one figure per core and an NVMe reports three. Listed flat
   * that is twenty near-identical numbers with the important one hidden among
   * them.
   */
  it('collapses each chip to one headline and a range', () => {
    const groups = groupSensors(temps);

    const cpu = groups.find((group) => group.chip === 'coretemp');
    expect(cpu?.headline?.celsius).toBe(39);
    expect(cpu?.lowest).toBe(34);
    expect(cpu?.highest).toBe(39);
    expect(cpu?.count).toBe(4);
  });

  it('prefers a composite sensor as a drive’s headline', () => {
    const drive = groupSensors(temps).find((group) => group.chip === 'nvme');
    expect(drive?.headline?.label).toBe('Composite');
  });

  it('orders the hottest chip first', () => {
    expect(groupSensors(temps)[0]?.chip).toBe('nvme');
  });

  it('takes a lone reading as its own headline', () => {
    const wifi = groupSensors(temps).find((group) => group.chip === 'iwlwifi_1');
    expect(wifi?.headline?.celsius).toBe(31);
    expect(wifi?.count).toBe(1);
  });

  /** Nothing speaks for a set of peers, so the range is the whole answer. */
  it('reports no headline when no sensor covers the others', () => {
    const group = groupSensors({ 'chip.a': 10, 'chip.b': 20 })[0];
    expect(group?.headline).toBeNull();
    expect(group?.highest).toBe(20);
  });

  it('has nothing to show when no sensor could be read', () => {
    expect(groupSensors({})).toEqual([]);
  });
});

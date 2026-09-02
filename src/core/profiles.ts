import type { MachineProfile, MaterialProfile, StackSettings } from './types';

/** First machine. Bed size lives here, never in geometry code. */
export const DEFAULT_MACHINE: MachineProfile = {
  name: 'Laser 730x410',
  bedWidth: 730,
  bedHeight: 410,
  margin: 5,
};

/**
 * Kerf is a placeholder until the kerf test figure is cut in this exact
 * material. Treat 0.15 as a guess, not a measurement.
 */
export const DEFAULT_MATERIAL: MaterialProfile = {
  name: 'Plexi 3 mm',
  thickness: 3,
  kerf: 0.15,
  notes: 'Kerf not yet measured — cut the kerf test figure before the first real job.',
};

export const DEFAULT_STACK: StackSettings = {
  spacerHeight: 6,
  /*
   * Both spelled out even though both are optional, so the default profile
   * describes a uniform stack of rings cut from the stock — which is what it
   * has always been. Omitting them would mean the same thing; saying them means
   * the panel has something to show before anything is touched.
   */
  spacerHeightTop: 6,
  spacerThickness: 0,
  // No spiral by default: a turned stack is a decision, and one that arrives
  // without being asked for would move every hole in every saved lamp.
  spacerHeightMid: 6,
  twistPerLayer: 0,
  twistOverrides: '',
};


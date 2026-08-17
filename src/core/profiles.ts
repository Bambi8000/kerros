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
};

/** Metric clearance holes, mm. Overridable per rod once RIG lands in M3. */
export const CLEARANCE_HOLES: Record<string, number> = {
  M3: 3.2,
  M4: 4.3,
  M5: 5.3,
  M6: 6.4,
  M8: 8.4,
};

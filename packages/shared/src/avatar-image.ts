import { createAvatar } from '@dicebear/core';
import * as avataaars from '@dicebear/avataaars';
import * as bottts from '@dicebear/bottts';
import type { AvatarOptions } from './avatar.js';

// Separate entry point: the web app and the admin page render avatars, while
// other shared consumers (such as the service worker) never load DiceBear.
export function avatarImage(seed: string, options?: AvatarOptions | null) {
  if (!options)
    return createAvatar(bottts, { seed, backgroundColor: ['e9e9d8'], radius: 50 }).toDataUri();
  const { top, facialHair, accessories, ...colorsAndFeatures } = options;
  const style: avataaars.Options = {
    backgroundColor: ['e9e9d8'],
    ...Object.fromEntries(Object.entries(colorsAndFeatures).map(([key, value]) => [key, [value]])),
    ...(top === 'none' ? { topProbability: 0 } : top ? { top: [top], topProbability: 100 } : {}),
    ...(facialHair === 'none'
      ? { facialHairProbability: 0 }
      : facialHair
        ? { facialHair: [facialHair], facialHairProbability: 100 }
        : {}),
    ...(accessories === 'none'
      ? { accessoriesProbability: 0 }
      : accessories
        ? { accessories: [accessories], accessoriesProbability: 100 }
        : {}),
  };
  return createAvatar(avataaars, { ...style, seed, radius: 50 }).toDataUri();
}

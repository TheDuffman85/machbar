import { createAvatar } from '@dicebear/core';
import * as avataaars from '@dicebear/avataaars';
import * as bottts from '@dicebear/bottts';
import type { AvatarOptions } from '@machbar/shared';

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

export function Avatar({
  seed,
  options,
  size = 48,
  alt = '',
}: {
  seed: string;
  options?: AvatarOptions | null;
  size?: number;
  alt?: string;
}) {
  return (
    <img className="avatar" src={avatarImage(seed, options)} alt={alt} width={size} height={size} />
  );
}

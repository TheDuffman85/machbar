import { avatarImage } from '@machbar/shared/avatar-image';
import type { AvatarOptions } from '@machbar/shared';

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

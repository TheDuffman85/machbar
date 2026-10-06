import {
  Bike,
  BookOpen,
  Briefcase,
  Coffee,
  Droplet,
  Dumbbell,
  Footprints,
  Heart,
  Leaf,
  Moon,
  Music,
  Pencil,
  Sprout,
  Star,
  Sun,
  Target,
  type LucideIcon,
} from 'lucide-react';
import { iconChoices, type EntityIcon as IconName } from '@machbar/shared';
import { useTranslation } from 'react-i18next';

const icons: Record<IconName, LucideIcon> = {
  leaf: Leaf,
  target: Target,
  heart: Heart,
  star: Star,
  book: BookOpen,
  dumbbell: Dumbbell,
  bike: Bike,
  footprints: Footprints,
  droplet: Droplet,
  coffee: Coffee,
  moon: Moon,
  sun: Sun,
  music: Music,
  pencil: Pencil,
  briefcase: Briefcase,
  sprout: Sprout,
};

export function EntityIcon({ name, size = 23 }: { name: IconName; size?: number }) {
  const Icon = icons[name];
  return <Icon size={size} aria-hidden="true" data-entity-icon={name} />;
}

export function IconPicker({
  value,
  color,
  onChange,
}: {
  value: IconName;
  color: string;
  onChange: (icon: IconName) => void;
}) {
  const { t } = useTranslation();
  return (
    <fieldset>
      <legend>{t('icon')}</legend>
      <div className="icon-options">
        {iconChoices.map((name) => (
          <button
            key={name}
            type="button"
            className={`${color} ${value === name ? 'selected' : ''}`}
            aria-label={t(`entityIcons.${name}`)}
            title={t(`entityIcons.${name}`)}
            aria-pressed={value === name}
            onClick={() => onChange(name)}
          >
            <EntityIcon name={name} size={22} />
          </button>
        ))}
      </div>
    </fieldset>
  );
}

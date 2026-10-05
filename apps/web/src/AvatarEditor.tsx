import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, RefreshCw, RotateCcw, Check } from 'lucide-react';
import { avatarChoices, type AvatarOptions, type Preferences } from '@machbar/shared';
import { Avatar } from './Avatar';
import { newId } from './uuid';

export type AvatarValue = Pick<Preferences, 'avatarSeed' | 'avatarOptions'>;

export function AvatarEditor({
  initial,
  onSave,
  onCancel,
  busy,
  canSave,
  draft = false,
}: {
  initial: AvatarValue;
  onSave: (value: AvatarValue) => Promise<void>;
  onCancel: () => void;
  busy: boolean;
  canSave: boolean;
  draft?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const original = { avatarSeed: initial.avatarSeed, avatarOptions: initial.avatarOptions ?? {} };
  const [value, setValue] = useState(original);
  function update(key: keyof AvatarOptions, option: string) {
    setValue((current) => {
      const avatarOptions = { ...current.avatarOptions };
      if (option) Object.assign(avatarOptions, { [key]: option });
      else delete avatarOptions[key];
      return { ...current, avatarOptions };
    });
  }
  function randomize() {
    const avatarOptions = Object.fromEntries(
      Object.entries(avatarChoices).map(([key, options]) => [
        key,
        options[Math.floor(Math.random() * options.length)],
      ]),
    ) as AvatarOptions;
    setValue({ avatarSeed: newId(), avatarOptions });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (canSave && !busy) await onSave(value);
  }
  return (
    <form className="avatar-customizer" onSubmit={(event) => void submit(event)}>
      <div className="avatar-customizer-body">
        <div className="avatar-preview">
          <Avatar
            seed={value.avatarSeed}
            options={value.avatarOptions}
            size={160}
            alt={t('avatarPreview')}
          />
          <p className="muted">{t('avatarPreviewHint')}</p>
          <button
            type="button"
            className="button secondary"
            data-autofocus
            disabled={busy}
            onClick={randomize}
          >
            <RefreshCw size={15} />
            {t('shuffleAvatar')}
          </button>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => setValue(original)}
          >
            <RotateCcw size={14} />
            {t('resetAvatar')}
          </button>
        </div>
        <div className="avatar-controls">
          {(Object.keys(avatarChoices) as (keyof AvatarOptions)[]).map((key) => {
            const options: readonly string[] = ['', ...avatarChoices[key]];
            const selected = value.avatarOptions[key] ?? '';
            const label = t(`avatarFields.${key}`);
            const color = key.endsWith('Color') && selected;
            function cycle(direction: number) {
              const index = options.indexOf(selected);
              update(key, options[(index + direction + options.length) % options.length]!);
            }
            return (
              <div className="avatar-field" key={key}>
                <label htmlFor={`${id}-${key}`}>{label}</label>
                <div className="avatar-option-control">
                  <button
                    type="button"
                    className="icon-button"
                    disabled={busy}
                    aria-label={t('previousAvatarOption', { field: label })}
                    onClick={() => cycle(-1)}
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <div className="avatar-select">
                    {color && (
                      <span
                        className="avatar-color-swatch"
                        style={{ backgroundColor: `#${color}` }}
                        aria-hidden="true"
                      />
                    )}
                    <select
                      id={`${id}-${key}`}
                      value={selected}
                      disabled={busy}
                      onChange={(event) => update(key, event.target.value)}
                    >
                      <option value="">{t('automaticAvatarOption')}</option>
                      {avatarChoices[key].map((option) => (
                        <option key={option} value={option}>
                          {t(`avatarChoices.${option}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={busy}
                    aria-label={t('nextAvatarOption', { field: label })}
                    onClick={() => cycle(1)}
                  >
                    <ChevronRight size={16} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="form-actions avatar-customizer-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={onCancel}>
          {t('cancel')}
        </button>
        <button type="submit" className="button primary" disabled={busy || !canSave}>
          <Check size={16} />
          {t(draft ? 'applyAvatar' : 'saveAvatar')}
        </button>
      </div>
    </form>
  );
}

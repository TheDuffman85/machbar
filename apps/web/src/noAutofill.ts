// Password managers ignore autocomplete="off" and guess from labels like "name"
// or "user ID", so opt out explicitly with each manager's own attribute.
export const noAutofill = {
  autoComplete: 'off',
  'data-1p-ignore': true,
  'data-lpignore': 'true',
  'data-bwignore': true,
  'data-form-type': 'other',
} as const;

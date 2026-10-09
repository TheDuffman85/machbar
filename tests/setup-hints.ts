// Browser state for a user who already dismissed the one-time setup hints, so
// the hints do not cover the UI under test. setup-hints.spec.ts covers them.
export const dismissedHints = {
  cookies: [],
  origins: [
    {
      origin: 'http://localhost:3100',
      localStorage: [
        { name: 'machbar-hint-install', value: '1' },
        { name: 'machbar-hint-notifications', value: '1' },
      ],
    },
  ],
};

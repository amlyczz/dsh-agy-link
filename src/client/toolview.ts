// Compatibility barrel: the mirror toolview now lives in ./toolview/.
// Keeping this file means existing imports of `./toolview.ts` (client entry,
// tests) resolve unchanged.
export * from './toolview/index.ts';

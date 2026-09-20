import { describe, it, expect } from 'vitest';
import { globToRegex, triggerEvents } from './trigger';
import { TRIGGER_EVENTS } from './trigger-events';

describe('globToRegex', () => {
  it('maps ** to .* and * to [^/]*, anchored', () => {
    expect(globToRegex('src/**')).toBe('^src/.*$');
    expect(globToRegex('src/*.ts')).toBe('^src/[^/]*\\.ts$');
    expect(globToRegex('package.json')).toBe('^package\\.json$');
  });
});

describe('triggerEvents', () => {
  it('unions and dedups rule events', () => {
    expect(
      triggerEvents({
        rules: [
          { on: [TRIGGER_EVENTS.PUSH, TRIGGER_EVENTS.PULL_REQUEST] },
          { on: TRIGGER_EVENTS.PUSH },
        ],
      }),
    ).toEqual([TRIGGER_EVENTS.PUSH, TRIGGER_EVENTS.PULL_REQUEST]);
  });
});

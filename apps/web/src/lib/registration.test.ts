import { describe, expect, it } from 'vitest';
import { ApiError, fallbackProblem } from './api';
import { isRegistrationClosedError, registrationOpen } from './registration';

describe('registrationOpen', () => {
  it('treats a missing flag as open (old backend / legacy demo data)', () => {
    expect(registrationOpen(null)).toBe(true);
    expect(registrationOpen(undefined)).toBe(true);
    expect(registrationOpen({})).toBe(true);
    expect(registrationOpen({ registration_open: true })).toBe(true);
  });

  it('honours an explicit closed flag', () => {
    expect(registrationOpen({ registration_open: false })).toBe(false);
  });
});

describe('isRegistrationClosedError', () => {
  it('detects the 403 permission_denied / registration_closed problem', () => {
    const error = new ApiError({
      ...fallbackProblem(403),
      code: 'permission_denied',
      details: { reason: 'registration_closed' },
    });

    expect(isRegistrationClosedError(error)).toBe(true);
  });

  it('ignores other errors and non-API errors', () => {
    const otherProblem = new ApiError({
      ...fallbackProblem(403),
      code: 'permission_denied',
      details: { reason: 'not_a_member' },
    });

    expect(isRegistrationClosedError(otherProblem)).toBe(false);
    expect(isRegistrationClosedError(new Error('registration_closed'))).toBe(false);
    expect(isRegistrationClosedError(null)).toBe(false);
  });
});

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  parseHistoryQuery,
  parseOwnNotification,
  parsePolicyInput,
  parseReminderInput,
  parseRetryInput,
  parseTestInput,
} from '../src/features/notifications/input.ts';

const policy = {
  revision: 0,
  enabled: true,
  invitations: true,
  closures: true,
  reminders: true,
  firstReminderHours: 48,
  repeatHours: 72,
  maximumReminders: 2,
};
describe('notification boundary', () => {
  it('validates policy ranges, booleans and optimistic revision', () => {
    expect(parsePolicyInput(policy)).toEqual(policy);
    for (const change of [
      { firstReminderHours: 23 },
      { repeatHours: 169 },
      { maximumReminders: 4 },
      { revision: -1 },
      { revision: 0.5 },
      { enabled: 'true' },
      { userId: 'member' },
      { teamId: 'T123' },
    ])
      expect(() => parsePolicyInput({ ...policy, ...change })).toThrow('invalid_request');
  });
  it('requires explicit confirmation and rejects caller-selected recipients and uncertain replay by default', () => {
    const body = { requestId: randomUUID(), revision: 0, confirm: true };
    expect(parseRetryInput(body)).toEqual({ ...body, confirmUncertain: false });
    expect(parseRetryInput({ ...body, confirmUncertain: true })).toMatchObject({
      confirmUncertain: true,
    });
    for (const change of [
      { confirm: false },
      { confirm: undefined },
      { email: 'other@example.com' },
      { userId: 'other' },
      { slackUserId: 'U123' },
    ])
      expect(() => parseRetryInput({ ...body, ...change })).toThrow('invalid_request');
  });
  it('bounds own-history selectors', () => {
    expect(parseHistoryQuery({})).toEqual({ cursor: null });
    for (const query of [{ userId: 'other' }, { limit: 100 }, { cursor: '' }, { cursor: '!bad' }])
      expect(() => parseHistoryQuery(query)).toThrow('invalid_request');
  });
  it('redacts corrupt stored notification data and publishes only safe own fields', () => {
    const row = {
      id: randomUUID(),
      pulse_id: null,
      kind: 'test',
      state: 'pending',
      channel: 'email',
      created_at: new Date(),
      updated_at: new Date(),
      user_id: 'private',
      reason: 'response_received',
    };
    expect(parseOwnNotification(row)).not.toHaveProperty('user_id');
    expect(parseOwnNotification(row)).not.toHaveProperty('reason');
    expect(() => parseOwnNotification({ ...row, state: 'private@example.com' })).toThrow(
      'invalid_notification_record',
    );
    expect(() => parseOwnNotification({ ...row, created_at: 'private-secret' })).toThrow(
      'invalid_notification_record',
    );
  });
});

it('rejects corrupt test/pulse context and chronology with redacted 500', () => {
  const row = {
    id: randomUUID(),
    pulse_id: null,
    kind: 'test',
    state: 'pending',
    channel: 'email',
    created_at: new Date('2026-01-02T00:00:00Z'),
    updated_at: new Date('2026-01-03T00:00:00Z'),
  };
  expect(() => parseOwnNotification({ ...row, pulse_id: randomUUID() })).toThrow(
    'invalid_notification_record',
  );
  expect(() =>
    parseOwnNotification({ ...row, updated_at: new Date('2026-01-01T00:00:00Z') }),
  ).toThrow('invalid_notification_record');
});

it('parses exact per-operation intents; ignores no uncertainty or channel flags', () => {
  const body = { requestId: randomUUID(), revision: 0, confirm: true };
  expect(parseReminderInput(body)).toEqual(body);
  expect(parseRetryInput(body)).toEqual({ ...body, confirmUncertain: false });
  expect(parseTestInput({ ...body, channel: 'email' })).toEqual({ ...body, channel: 'email' });
  expect(parseTestInput({ ...body, channel: 'slack' })).toEqual({ ...body, channel: 'slack' });
  for (const value of [
    { ...body, confirmUncertain: false },
    { ...body, channel: 'email' },
  ])
    expect(() => parseReminderInput(value)).toThrow('invalid_request');
  for (const value of [
    body,
    { ...body, channel: 'other' },
    { ...body, channel: 'email', confirmUncertain: false },
    { ...body, channel: 'email', userId: 'other' },
  ])
    expect(() => parseTestInput(value)).toThrow('invalid_request');
  expect(() => parseRetryInput({ ...body, channel: 'email' })).toThrow('invalid_request');
});

it('redacts stored tests and ambiguous acceptance without a channel', () => {
  const row = {
    id: randomUUID(),
    pulse_id: null,
    kind: 'test',
    state: 'pending',
    channel: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
  expect(() => parseOwnNotification(row)).toThrow('invalid_notification_record');
  expect(() =>
    parseOwnNotification({
      ...row,
      pulse_id: randomUUID(),
      kind: 'invitation',
      state: 'uncertain',
    }),
  ).toThrow('invalid_notification_record');
});

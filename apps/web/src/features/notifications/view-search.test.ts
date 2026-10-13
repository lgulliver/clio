import { describe, expect, it } from 'vitest';
import { parseNotificationSearch } from './view-search';

const workspace = '11111111-1111-4111-8111-111111111111';
const pulse = '00000000-0000-4000-8000-000000000002';

describe('parseNotificationSearch', () => {
  it('keeps a valid workspace and pulse pair, normalised to lower case', () => {
    expect(
      parseNotificationSearch({ workspace: workspace.toUpperCase(), pulse: pulse.toUpperCase() }),
    ).toEqual({ workspace, pulse });
  });

  it('keeps a workspace-only link and its fixed Slack outcome', () => {
    expect(parseNotificationSearch({ workspace, notificationLink: 'success' })).toEqual({
      workspace,
      notificationLink: 'success',
    });
    expect(parseNotificationSearch({ workspace, notificationLink: 'failed' })).toEqual({
      workspace,
      notificationLink: 'failed',
    });
  });

  it('rejects a pulse without a workspace and a malformed pair as a whole', () => {
    expect(parseNotificationSearch({ pulse })).toEqual({});
    expect(parseNotificationSearch({ workspace, pulse: 'not-a-uuid' })).toEqual({});
    expect(parseNotificationSearch({ workspace: 'nope', pulse })).toEqual({});
    expect(parseNotificationSearch({ workspace, pulse: [pulse] })).toEqual({});
    expect(parseNotificationSearch({ workspace: 7, pulse: 8 })).toEqual({});
  });

  it('drops arbitrary outcomes, return URLs and unknown keys', () => {
    expect(
      parseNotificationSearch({
        workspace,
        notificationLink: 'https://evil.example.test',
        returnTo: 'https://evil.example.test',
        code: 'provider-code',
      }),
    ).toEqual({ workspace });
    expect(parseNotificationSearch({ notificationLink: 'success' })).toEqual({});
  });

  it('accepts the workspace-free callback failure alone and rejects it beside malformed targets', () => {
    expect(parseNotificationSearch({ notificationLink: 'failed' })).toEqual({
      notificationLink: 'failed',
    });
    expect(parseNotificationSearch({ notificationLink: 'failed', pulse })).toEqual({});
    expect(parseNotificationSearch({ notificationLink: 'failed', workspace: 'nope' })).toEqual({});
  });

  it('does not combine an outcome with a pulse target', () => {
    expect(parseNotificationSearch({ workspace, pulse, notificationLink: 'success' })).toEqual({
      workspace,
      pulse,
    });
  });

  it('tolerates non-object input', () => {
    expect(parseNotificationSearch(null)).toEqual({});
    expect(parseNotificationSearch('workspace')).toEqual({});
    expect(parseNotificationSearch([workspace])).toEqual({});
  });
});

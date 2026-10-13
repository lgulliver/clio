import { describe, expect, it } from 'vitest';
import type { NotificationKind } from '../src/features/notifications/contract.ts';
import { buildPulseLink } from '../src/features/notifications/provider.ts';
import { buildWorkspaceLink, renderNotice } from '../src/features/notifications/templates.ts';
import { fixtureOrigin, pulseId, workspaceId } from './fixtures/notification-transports.ts';

const link = buildPulseLink(fixtureOrigin, workspaceId, pulseId);
const kinds: readonly NotificationKind[] = ['invitation', 'reminder', 'closure'];

describe('notification links', () => {
  it('builds only the fixed-origin exact pulse route', () => {
    expect(link).toBe(
      `${fixtureOrigin}/developer-experience?workspace=${workspaceId}&pulse=${pulseId}`,
    );
    expect(buildWorkspaceLink(fixtureOrigin, workspaceId)).toBe(
      `${fixtureOrigin}/developer-experience?workspace=${workspaceId}`,
    );
    expect(buildPulseLink('http://localhost:5173', workspaceId.toUpperCase(), pulseId)).toBe(
      `http://localhost:5173/developer-experience?workspace=${workspaceId}&pulse=${pulseId}`,
    );
  });

  it('rejects origins with paths, credentials or non-HTTP schemes and non-UUID identifiers', () => {
    for (const origin of [
      'https://clio.example.test/app',
      'https://user:secret@clio.example.test',
      'javascript:alert(1)',
      'https://clio.example.test?x=1',
      'clio.example.test',
    ])
      expect(() => buildPulseLink(origin, workspaceId, pulseId)).toThrow();
    expect(() => buildPulseLink(fixtureOrigin, 'not-a-uuid', pulseId)).toThrow();
    expect(() => buildPulseLink(fixtureOrigin, workspaceId, `${pulseId}&x=1`)).toThrow();
  });
});

describe('renderNotice', () => {
  it('uses neutral wording that distinguishes closure without claiming results', () => {
    expect(renderNotice('closure', link).slackText).toContain('Pulse closed');
    expect(renderNotice('closure', link).text).not.toMatch(/result|report/i);
    expect(renderNotice('invitation', link).subject).not.toBe(
      renderNotice('closure', link).subject,
    );
  });

  it('never discloses participation, answers, scores or identifying context', () => {
    for (const kind of [...kinds, 'test' as const]) {
      const message = renderNotice(
        kind,
        kind === 'test' ? buildWorkspaceLink(fixtureOrigin, workspaceId) : link,
      );
      for (const value of [message.subject, message.text, message.html, message.slackText])
        expect(value).not.toMatch(
          /responded|average|score|participants|answers?\b|xox[bp]-|token|@/i,
        );
    }
    expect(renderNotice('reminder', link).text).not.toMatch(/responded|average|score|participants/);
  });

  it('carries exactly the supplied link in every representation and disables nothing else', () => {
    for (const kind of kinds) {
      const message = renderNotice(kind, link);
      expect(message.text).toContain(link);
      expect(message.html).toContain(`href="${link.replaceAll('&', '&amp;')}"`);
      expect(message.slackText).toContain(`<${link}|`);
      expect(message.subject).not.toMatch(/[\r\n]/);
      expect(message.html).not.toMatch(/<script|on\w+=|<img|<iframe/i);
    }
  });

  it('supports the pulse-free test notice with a workspace link', () => {
    const message = renderNotice('test', buildWorkspaceLink(fixtureOrigin, workspaceId));
    expect(message.text).toContain(`workspace=${workspaceId}`);
    expect(message.text).not.toContain('pulse=');
    expect(message.slackText).toMatch(/test/i);
  });

  it('refuses links that are not fixed Clio notification routes', () => {
    for (const unsafe of [
      `${fixtureOrigin}/other?workspace=${workspaceId}`,
      `${fixtureOrigin}/developer-experience?workspace=${workspaceId}&pulse=${pulseId}&next=https://evil.test`,
      `${fixtureOrigin}/developer-experience?workspace=${workspaceId}#frag`,
      `${fixtureOrigin}/developer-experience?workspace=${workspaceId}"><script>`,
      `javascript:alert(1)//developer-experience?workspace=${workspaceId}`,
      `https://user:pw@clio.example.test/developer-experience?workspace=${workspaceId}`,
      `${fixtureOrigin}/developer-experience?pulse=${pulseId}`,
    ])
      expect(() => renderNotice('invitation', unsafe)).toThrow();
  });
});

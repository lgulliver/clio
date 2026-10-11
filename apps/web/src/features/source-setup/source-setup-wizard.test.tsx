import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode, useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { SourceSetupPresentation, SourceSetupStatus } from './provider-state';
import { SourceSetupWizard } from './source-setup-wizard';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));
vi.mock('../github-collection/github-collection', () => ({ GitHubCollection: ProviderProbe }));
vi.mock('../argo-collection/argo-collection', () => ({ ArgoCollection: ProviderProbe }));
vi.mock('../deployment-mappings/deployment-mappings', () => ({
  DeploymentMappings: ProviderProbe,
}));
vi.mock('../measurement-evidence/measurement-evidence', () => ({
  MeasurementEvidence: ({ basisProvider }: { basisProvider: string }) => (
    <p>Independent evidence provider: {basisProvider}</p>
  ),
}));

function ProviderProbe({ setup }: { setup: SourceSetupPresentation }) {
  const [status, setStatus] = useState<SourceSetupStatus>({
    ready: false,
    busy: false,
    hasSavedResult: false,
  });
  useEffect(() => setup.onStatus(status), [setup.onStatus, status]);
  return (
    <>
      <div hidden={setup.step !== 'configure'}>
        <label>
          Source draft
          <input defaultValue="" />
        </label>
        <button type="button" onClick={() => setStatus({ ...status, ready: true })}>
          Save source
        </button>
        <button type="button" onClick={() => setStatus({ ...status, ready: false })}>
          Unsaved source changes
        </button>
      </div>
      <div hidden={setup.step !== 'collect'}>
        <button type="button" onClick={() => setStatus({ ...status, busy: false })}>
          Queue collection
        </button>
        <button type="button" onClick={() => setStatus({ ...status, busy: true })}>
          Unconfirmed collection
        </button>
        <button
          type="button"
          onClick={() => setStatus({ ...status, busy: false, hasSavedResult: true })}
        >
          Complete collection
        </button>
      </div>
      <button type="button" onClick={setup.onAccessLost}>
        Lose source access
      </button>
    </>
  );
}
const workspace = { id: 'workspace', name: 'Delivery workspace', role: 'owner' as const };
const services = [{ id: 'service', name: 'Checkout', workspaceId: workspace.id }];
function show(options: { role?: 'owner' | 'member'; empty?: boolean } = {}) {
  const onClose = vi.fn();
  const onAccessLost = vi.fn();
  render(
    <SourceSetupWizard
      workspace={{ ...workspace, role: options.role ?? 'owner' }}
      services={options.empty ? [] : services}
      userId="owner"
      validSelection={() => true}
      onAccessLost={onAccessLost}
      onClose={onClose}
      createServiceForm={<p>Service creation form</p>}
    />,
  );
  return { user: userEvent.setup(), onClose, onAccessLost };
}
async function chooseSource(user: ReturnType<typeof userEvent.setup>, source: string) {
  await user.selectOptions(screen.getByLabelText('Service for setup'), 'service');
  await user.click(screen.getByRole('button', { name: 'Next: Source' }));
  await user.click(screen.getByRole('radio', { name: new RegExp(source) }));
  await user.click(screen.getByRole('button', { name: 'Next: Connection' }));
}

describe('source setup wizard', () => {
  it('requires service and source choices, exposes progress, and focuses each step', async () => {
    const { user } = show();
    expect(screen.getByRole('heading', { name: 'Step 1 of 5: Service' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Next: Source' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Next: Source' }));
    expect(screen.getByRole('heading', { name: 'Step 1 of 5: Service' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Next: Source' })).toHaveFocus();
    await user.selectOptions(screen.getByLabelText('Service for setup'), 'service');
    await user.click(screen.getByRole('button', { name: 'Next: Source' }));
    expect(screen.getByRole('heading', { name: 'Step 2 of 5: Source' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Next: Connection' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(
      within(screen.getByRole('list', { name: 'Setup progress' }))
        .getByText('Source')
        .closest('li'),
    ).toHaveAttribute('aria-current', 'step');
  });
  it('gates progress on saved state and preserves drafts through Back and Next', async () => {
    const { user } = show();
    await chooseSource(user, 'GitHub Deployments');
    expect(screen.getByRole('button', { name: 'Next: Collection' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.type(screen.getByLabelText('Source draft'), 'saved repository');
    await user.click(screen.getByRole('button', { name: 'Save source' }));
    await user.click(screen.getByRole('button', { name: 'Next: Collection' }));
    expect(screen.queryByRole('button', { name: 'Save source' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Source draft')).toHaveValue('saved repository');
    await user.click(screen.getByRole('button', { name: 'Unsaved source changes' }));
    expect(screen.getByRole('button', { name: 'Next: Collection' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
  it.each(['GitHub Deployments', 'Argo CD'])(
    'waits for completed collection and pins %s evidence',
    async (source) => {
      const { user, onClose } = show();
      await chooseSource(user, source);
      await user.click(screen.getByRole('button', { name: 'Save source' }));
      await user.click(screen.getByRole('button', { name: 'Next: Collection' }));
      await user.click(screen.getByRole('button', { name: 'Queue collection' }));
      expect(screen.getByRole('button', { name: 'Next: Evidence' })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
      expect(screen.getByRole('button', { name: 'Back' })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      );
      await user.click(screen.getByRole('button', { name: 'Complete collection' }));
      await user.click(screen.getByRole('button', { name: 'Next: Evidence' }));
      expect(screen.getByRole('region', { name: 'Evidence checklist' })).toBeVisible();
      expect(
        screen.getByText(
          `Independent evidence provider: ${source === 'Argo CD' ? 'argocd' : 'github'}`,
        ),
      ).toBeVisible();
      expect(
        screen.getByText(/connection setup alone cannot establish complete metrics/),
      ).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Finish setup review' }));
      expect(onClose).toHaveBeenCalledOnce();
    },
  );
  it('keeps fictional demo distinct from independent real-source evidence', async () => {
    const { user } = show();
    await chooseSource(user, 'Fictional demo');
    await user.click(screen.getByRole('button', { name: 'Save source' }));
    await user.click(screen.getByRole('button', { name: 'Next: Collection' }));
    await user.click(screen.getByRole('button', { name: 'Complete collection' }));
    await user.click(screen.getByRole('button', { name: 'Next: Evidence' }));
    expect(screen.getByText(/This demo uses fictional evidence/)).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Evidence checklist' })).not.toBeInTheDocument();
  });
  it('allows closing accepted jobs with no worker while preserving queued-not-success distinction', async () => {
    const { user, onClose } = show();
    await chooseSource(user, 'GitHub Deployments');
    await user.click(screen.getByRole('button', { name: 'Save source' }));
    await user.click(screen.getByRole('button', { name: 'Next: Collection' }));
    await user.click(screen.getByRole('button', { name: 'Queue collection' }));
    expect(screen.getByRole('button', { name: 'Next: Evidence' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Close setup' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('offers safe exit from an unconfirmed request and keeps Back available', async () => {
    const { user, onClose } = show();
    await chooseSource(user, 'Argo CD');
    await user.click(screen.getByRole('button', { name: 'Save source' }));
    await user.click(screen.getByRole('button', { name: 'Next: Collection' }));
    await user.click(screen.getByRole('button', { name: 'Unconfirmed collection' }));
    await user.click(screen.getByRole('button', { name: 'Close setup' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Check source history before submitting again',
    );
    await user.click(screen.getByRole('button', { name: 'Keep setup' }));
    expect(screen.getByRole('heading', { name: 'Step 4 of 5: Collection' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: 'Step 3 of 5: Connection' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Close setup' }));
    await user.click(screen.getByRole('button', { name: 'Close setup anyway' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
  it('clears the exit prompt after confirmation resolves and restores prompt focus', async () => {
    const { user } = show();
    await chooseSource(user, 'Argo CD');
    await user.click(screen.getByRole('button', { name: 'Save source' }));
    await user.click(screen.getByRole('button', { name: 'Next: Collection' }));
    await user.click(screen.getByRole('button', { name: 'Unconfirmed collection' }));
    await user.click(screen.getByRole('button', { name: 'Close setup' }));
    screen.getByRole('button', { name: 'Keep setup' }).focus();
    fireEvent.click(screen.getByRole('button', { name: 'Complete collection' }));
    expect(screen.queryByRole('button', { name: 'Keep setup' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Step 4 of 5: Collection' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Unconfirmed collection' }));
    expect(screen.queryByRole('button', { name: 'Close setup anyway' })).not.toBeInTheDocument();
  });
  it('clears source progress on provider change and blocks after access loss', async () => {
    const { user, onAccessLost } = show();
    await chooseSource(user, 'GitHub Deployments');
    await user.click(screen.getByRole('button', { name: 'Save source' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('radio', { name: /Argo CD/ }));
    await user.click(screen.getByRole('button', { name: 'Next: Connection' }));
    expect(screen.getByRole('button', { name: 'Next: Collection' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Lose source access' }));
    expect(onAccessLost).toHaveBeenCalledOnce();
    expect(screen.getByRole('alert')).toHaveTextContent('Source access changed');
    expect(screen.getByRole('heading', { name: 'Step 3 of 5: Connection' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Next: Collection' })).not.toBeInTheDocument();
  });
  it('supports first service creation and hides owner wizard for members', () => {
    show({ empty: true });
    expect(screen.getByText('Create your first service to continue.')).toBeVisible();
    expect(screen.getByText('Service creation form')).toBeVisible();
  });
  it('does not expose owner setup controls to members', () => {
    show({ role: 'member' });
    expect(
      screen.queryByRole('region', { name: 'Data source setup wizard' }),
    ).not.toBeInTheDocument();
  });
});

import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { type Organization, parseDeleted, parseUpdatedProduct, parseUpdatedTeam } from './api';

type Save = <T>(
  event: FormEvent,
  endpoint: string,
  body: object,
  parse: (value: unknown) => T,
  message: string,
  clear: () => void,
  method?: 'PATCH' | 'DELETE',
) => Promise<void>;

function DeleteConfirmation({
  name,
  description,
  busy,
  confirm,
  cancel,
}: {
  name: string;
  description: string;
  busy: boolean;
  confirm: (event: FormEvent) => void;
  cancel: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <section className="mt-3" aria-label={`Delete ${name} confirmation`}>
      <h5 ref={heading} tabIndex={-1} className="font-semibold">
        Delete {name}?
      </h5>
      <p className="mt-2 text-sm">{description}</p>
      <form onSubmit={confirm} className="mt-3 flex flex-wrap gap-2">
        <button type="submit" className="control" disabled={busy}>
          Confirm deletion
        </button>
        <button type="button" className="control" disabled={busy} onClick={cancel}>
          Cancel deletion
        </button>
      </form>
    </section>
  );
}

export function OrganizationLifecycle({
  organization,
  busy,
  save,
}: {
  organization: Organization;
  busy: boolean;
  save: Save;
}) {
  const id = useId();
  const [teamId, setTeamId] = useState('');
  const [teamName, setTeamName] = useState('');
  const [productId, setProductId] = useState('');
  const [productName, setProductName] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [deletingTeam, setDeletingTeam] = useState(false);
  const [deletingProduct, setDeletingProduct] = useState(false);
  const [focusAfterSave, setFocusAfterSave] = useState<'team' | 'product' | undefined>();
  const teamDelete = useRef<HTMLButtonElement>(null);
  const productDelete = useRef<HTMLButtonElement>(null);
  const teamSelect = useRef<HTMLSelectElement>(null);
  const productSelect = useRef<HTMLSelectElement>(null);
  const team = organization.teams.find((item) => item.id === teamId);
  const product = organization.products.find((item) => item.id === productId);
  const products = organization.products.filter((item) => item.teamId === teamId);
  const assigned = organization.assignments.filter((item) => item.productId === productId).length;
  useEffect(() => {
    if (!busy && focusAfterSave) {
      (focusAfterSave === 'team' ? teamSelect : productSelect).current?.focus();
      setFocusAfterSave(undefined);
    }
  }, [busy, focusAfterSave]);
  useEffect(() => {
    if (deletingTeam && (!team || products.length > 0)) {
      setDeletingTeam(false);
      setFocusAfterSave('team');
    }
  }, [team, products.length, deletingTeam]);
  useEffect(() => {
    if (deletingProduct && !product) {
      setDeletingProduct(false);
      setFocusAfterSave('product');
    }
  }, [product, deletingProduct]);
  return (
    <section aria-label="Manage existing teams and products" className="mt-6">
      <h4 className="font-semibold">Manage existing teams and products</h4>
      <div className="organization-forms organization-lifecycle">
        <div>
          <label htmlFor={`${id}-edit-team`}>Team to edit</label>
          <select
            ref={teamSelect}
            id={`${id}-edit-team`}
            className="field"
            value={team?.id ?? ''}
            disabled={busy}
            onChange={(event) => {
              const selected = organization.teams.find((item) => item.id === event.target.value);
              setTeamId(selected?.id ?? '');
              setTeamName(selected?.name ?? '');
              setDeletingTeam(false);
            }}
          >
            <option value="">Choose a team</option>
            {organization.teams.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          {team && (
            <>
              <form
                onSubmit={(event) =>
                  void save(
                    event,
                    `/teams/${team.id}`,
                    { name: teamName.trim() },
                    (value) => parseUpdatedTeam(value, organization.workspaceId, team.id),
                    'Team updated.',
                    () => {},
                    'PATCH',
                  )
                }
              >
                <label htmlFor={`${id}-edit-team-name`}>Team name</label>
                <input
                  id={`${id}-edit-team-name`}
                  className="field"
                  required
                  value={teamName}
                  readOnly={busy}
                  onChange={(event) => setTeamName(event.target.value)}
                />
                <button type="submit" className="control" disabled={busy || deletingTeam}>
                  Save team
                </button>
              </form>
              <p className="mt-3 text-sm">
                {products.length} {products.length === 1 ? 'product belongs' : 'products belong'} to
                this team. Move or delete all products and close or cancel draft/open SPACE pulses
                before deleting the team. Archived pulse results remain available.
              </p>
              <button
                ref={teamDelete}
                type="button"
                className="control mt-3"
                disabled={busy || products.length > 0}
                onClick={() => setDeletingTeam(true)}
              >
                Delete team
              </button>
              {deletingTeam && (
                <DeleteConfirmation
                  name={team.name}
                  description="This empty team will be deleted and its current primary-team assignments cleared. Services, saved evidence and archived pulse results are preserved."
                  busy={busy}
                  cancel={() => {
                    setDeletingTeam(false);
                    teamDelete.current?.focus();
                  }}
                  confirm={(event) =>
                    void save(
                      event,
                      `/teams/${team.id}`,
                      {},
                      (value) => parseDeleted(value, 'deletedTeamId', team.id),
                      'Team deleted.',
                      () => {
                        setTeamId('');
                        setDeletingTeam(false);
                        setFocusAfterSave('team');
                      },
                      'DELETE',
                    )
                  }
                />
              )}
            </>
          )}
        </div>
        <div>
          <label htmlFor={`${id}-edit-product`}>Product to edit</label>
          <select
            ref={productSelect}
            id={`${id}-edit-product`}
            className="field"
            value={product?.id ?? ''}
            disabled={busy}
            onChange={(event) => {
              const selected = organization.products.find((item) => item.id === event.target.value);
              setProductId(selected?.id ?? '');
              setProductName(selected?.name ?? '');
              setOwnerId(selected?.teamId ?? '');
              setDeletingProduct(false);
            }}
          >
            <option value="">Choose a product</option>
            {organization.products.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          {product && (
            <>
              <form
                onSubmit={(event) =>
                  void save(
                    event,
                    `/products/${product.id}`,
                    { name: productName.trim(), teamId: ownerId },
                    (value) => parseUpdatedProduct(value, organization.workspaceId, product.id),
                    'Product updated.',
                    () => {},
                    'PATCH',
                  )
                }
              >
                <label htmlFor={`${id}-edit-product-name`}>Product name</label>
                <input
                  id={`${id}-edit-product-name`}
                  className="field"
                  required
                  value={productName}
                  readOnly={busy}
                  onChange={(event) => setProductName(event.target.value)}
                />
                <label htmlFor={`${id}-edit-owner`}>Product owning team</label>
                <select
                  id={`${id}-edit-owner`}
                  className="field"
                  required
                  value={organization.teams.some((item) => item.id === ownerId) ? ownerId : ''}
                  disabled={busy}
                  onChange={(event) => setOwnerId(event.target.value)}
                >
                  <option value="">Choose a team</option>
                  {organization.teams.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <button type="submit" className="control" disabled={busy || deletingProduct}>
                  Save product
                </button>
              </form>
              <p className="mt-3 text-sm">
                Moving this product moves its services to the new team in current ownership views.
                Saved results remain unchanged.
              </p>
              <button
                ref={productDelete}
                type="button"
                className="control mt-3"
                disabled={busy}
                onClick={() => setDeletingProduct(true)}
              >
                Delete product
              </button>
              {deletingProduct && (
                <DeleteConfirmation
                  name={product.name}
                  description={`${assigned} ${assigned === 1 ? 'service' : 'services'} currently assigned. Deleting this product makes all its services unassigned in Engineering. Services, connections and saved evidence are preserved.`}
                  busy={busy}
                  cancel={() => {
                    setDeletingProduct(false);
                    productDelete.current?.focus();
                  }}
                  confirm={(event) =>
                    void save(
                      event,
                      `/products/${product.id}`,
                      {},
                      (value) => parseDeleted(value, 'deletedProductId', product.id),
                      'Product deleted. Its services are now unassigned.',
                      () => {
                        setProductId('');
                        setDeletingProduct(false);
                        setFocusAfterSave('product');
                      },
                      'DELETE',
                    )
                  }
                />
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

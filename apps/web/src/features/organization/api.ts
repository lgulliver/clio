import { ApiError, record, type Service } from '../identity/api';

export type Team = { id: string; workspaceId: string; name: string };
export type Product = Team & { teamId: string };
export type Assignment = { serviceId: string; productId: string | null };
export type Organization = {
  workspaceId: string;
  teams: Team[];
  products: Product[];
  assignments: Assignment[];
  services: Service[];
};

function uuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  )
    throw new ApiError(0);
  return value.toLowerCase();
}
function exact(value: unknown, keys: string[]) {
  const row = record(value);
  if (
    Object.keys(row).length !== keys.length ||
    Object.keys(row).some((key) => !keys.includes(key))
  )
    throw new ApiError(0);
  return row;
}
function named(value: unknown, workspaceId: string, keys = ['id', 'workspaceId', 'name']): Team {
  const row = exact(value, keys);
  if (
    row.workspaceId !== workspaceId ||
    typeof row.name !== 'string' ||
    !row.name.trim() ||
    row.name !== row.name.trim() ||
    [...row.name].length > 200
  )
    throw new ApiError(0);
  return { id: uuid(row.id), workspaceId, name: row.name };
}
export function parseTeam(value: unknown, workspaceId: string): Team {
  return named(exact(value, ['team']).team, workspaceId);
}
export function parseProduct(value: unknown, workspaceId: string): Product {
  const row = exact(exact(value, ['product']).product, ['id', 'workspaceId', 'name', 'teamId']);
  return {
    ...named(row, workspaceId, ['id', 'workspaceId', 'name', 'teamId']),
    teamId: uuid(row.teamId),
  };
}
export function parseAssignment(value: unknown, serviceId: string): Assignment {
  const row = exact(exact(value, ['assignment']).assignment, ['serviceId', 'productId']);
  if (row.serviceId !== serviceId) throw new ApiError(0);
  return { serviceId, productId: row.productId === null ? null : uuid(row.productId) };
}
export function parseOrganization(value: unknown, workspaceId: string): Organization {
  const row = exact(value, ['workspaceId', 'teams', 'products', 'services', 'assignments']);
  if (
    row.workspaceId !== workspaceId ||
    !Array.isArray(row.teams) ||
    !Array.isArray(row.products) ||
    !Array.isArray(row.assignments) ||
    !Array.isArray(row.services)
  )
    throw new ApiError(0);
  const teams = row.teams.map((team: unknown) => named(team, workspaceId));
  const products = row.products.map((product: unknown) => parseProduct({ product }, workspaceId));
  const assignments = row.assignments.map((assignment: unknown) => {
    const item = record(assignment);
    return parseAssignment({ assignment }, uuid(item.serviceId));
  });
  const services = row.services.map((service: unknown) => named(service, workspaceId));
  const teamIds = new Set(teams.map((team) => team.id));
  const productIds = new Set(products.map((product) => product.id));
  const serviceIds = new Set(services.map((service) => service.id));
  if (
    teamIds.size !== teams.length ||
    productIds.size !== products.length ||
    serviceIds.size !== services.length ||
    assignments.length !== serviceIds.size ||
    new Set(assignments.map((item) => item.serviceId)).size !== assignments.length ||
    products.some((product) => !teamIds.has(product.teamId)) ||
    assignments.some(
      (item) =>
        !serviceIds.has(item.serviceId) ||
        (item.productId !== null && !productIds.has(item.productId)),
    )
  )
    throw new ApiError(0);
  return { workspaceId, teams, products, services, assignments };
}

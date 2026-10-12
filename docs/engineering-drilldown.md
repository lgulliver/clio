# Engineering drill-down

Engineering is the organization within the selected Clio workspace. Workspace membership controls access; teams and products organize services, not user permissions.

The initial ownership model is:

- A workspace contains teams and services.
- A team can own multiple products.
- Each product belongs to one team.
- Each service can belong to one product, or remain unassigned.

Products spanning teams are not supported initially. Existing services start unassigned; their identities, provider connections and saved evidence are preserved.

## Set up ownership

1. Sign in and open **Workspace**. Choose your workspace.
2. Expand **Organize teams and products**.
3. Create a team, then create products with their owning team.
4. Choose a service and its assigned product, then **Save service assignment**.
5. To remove an assignment, choose **Unassigned** and save again.

Workspace owners edit ownership. Members read it. Team and product names are unique within their workspace. This first slice creates teams/products and changes service assignments; renaming, deleting and moving products between teams are not implemented.

## Explore delivery

Open **Overview** and choose a workspace. Engineering includes every service, including unassigned services. Team buttons open their products; product buttons open their services. Service names open saved independent measurements and native collection histories, including trends and evidence details. Breadcrumbs return to parent scopes. Team, Product and Service selectors also navigate directly; choosing a product selects its owning team.

Select a **Result source** to compare independent measurements, GitHub Deployments, Argo CD or demo data separately. Comparisons load ten services per page and read up to 25 successful saved results per visible service. The table shows the newest successful result for that source, with reporting window, metric status, quality reasons and coverage. Empty histories, unavailable metrics and older results without metric details remain explicit. Failed or pending requests do not erase earlier successes; inspect service history for request status.

Reporting windows, source revisions and OEMS revisions can differ between services. Group views compare service-level results; they do not sum overlapping provider counts or average medians into team/product metrics. No group-level OEMS metric is calculated. Service trends retain source/revision boundaries. One saved period provides one point, not an invented trend.

Grouping uses current ownership. Reassigning a service changes where it appears, including when browsing past results, without rewriting immutable results. Saved times and evidence cutoffs remain visible; this view does not assert collection freshness or complete production coverage.

## Local upgrade

Migration `0014_organization.sql` adds the hierarchy and nullable service assignments. Run `pnpm db:migrate` explicitly before using the updated API. API startup never migrates. Composite foreign keys reject cross-workspace ownership; every API read/write rechecks the current session and workspace membership in its transaction.

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

Workspace owners edit ownership. Members read it. Team and product names are unique within their workspace. Under **Manage existing teams and products**, select a team or product to rename it. Select a product’s owning team and save to move it, together with its current service group. IDs, connections and immutable evidence are preserved. Delete controls require confirmation. Only empty teams can be deleted; move or delete their products first. Deleting a product makes its services unassigned, preserving services, connections and saved results. Refresh organization to load changes made in another tab.

## Explore delivery

Open **Overview** and choose a workspace. Engineering includes every service, including unassigned services. Team buttons open their products; product buttons open their services. Service names open saved independent measurements and native collection histories, including trends and evidence details. Breadcrumbs return to parent scopes. Team, Product and Service selectors also navigate directly; choosing a product selects its owning team.

Select a **Result source** to compare independent measurements, GitHub Deployments, Argo CD or demo data separately. Comparisons load ten services per page and read up to 25 successful saved results per visible service. **Latest per service** shows each service's newest successful result. Choose an exact **Reporting window** to align rows to the same UTC start and exclusive end. Options come from loaded histories on the current page; a missing match does not mean no deployment occurred, and older saved results may exist outside these bounds. Open a service to browse its full paged history. Selecting a window uses already loaded results; **Refresh comparisons** reads storage again without starting collection.

The selected window survives team/product/service navigation and service pagination. If it is absent on another page, it remains selected and rows disclose missing matches. Changing source resets the filter to **Latest per service**. Rows retain metric status, quality reasons, coverage and saved context. Empty histories, unavailable metrics and older results without metric details remain explicit. Failed or pending requests do not erase earlier successes; inspect service history for request status.

**Delivery trends by service** shows separate lines for services on the current page. Select deployments, lead time, failure rate, rework rate or recovery time. Each series stays within its selected result's provider, connection/mapping revision and OEMS revision. In Latest mode it includes every compatible period in loaded history, even if the most recently saved result is an older backfill. With an exact window selected, it shows compatible windows ending no later than that window. Duplicate windows use the newest compatible capture. Legacy captures without metrics and unavailable values remain gaps. Points use a time axis. Lines join only a service's own adjacent, non-overlapping windows (previous exclusive end equals next start), independently of other services. Gaps, overlaps and unavailable values break lines. Only recorded windows are shown; unsaved intervals remain unknown. One period produces one point. **Chart data and quality** exposes exact windows, values, metric quality, source revisions, saved times and evidence cutoffs.

Reporting windows, source revisions and OEMS revisions can differ between services. Group views compare service-level results; they do not sum overlapping provider counts or average medians into team/product metrics. No group-level OEMS metric is calculated. Service trends retain source/revision boundaries. One saved period provides one point, not an invented trend.

Grouping uses current ownership. Reassigning a service changes where it appears, including when browsing past results, without rewriting immutable results. Saved times and evidence cutoffs remain visible; this view does not assert collection freshness or complete production coverage.

## Coverage and freshness

Group comparisons summarize only the current page, selected source and reporting window. Saved results, absent matches, pending reads, failed reads and legacy results without metric details stay separate. Open summary details to inspect affected services. Coverage declarations and each saved OEMS metric status are counted independently; complete coverage does not upgrade provisional metrics. Empty observations retain their saved status, rather than becoming missing results.

Collection age uses the collection evidence cutoff, including an independent measurement’s older collection basis. The measurement evidence cutoff and saved-result completion remain separate. Collection completion is unavailable for independent measurements. Choose a 1, 7 or 30 day age threshold; the default is 7 days. Age compares with your device clock and refreshes each minute without collection requests. Cutoffs ahead of that clock are disclosed separately. Historical windows naturally age; these thresholds are inspection aids, not freshness guarantees, service health grades or proof of complete production coverage.

## Local upgrade

Migration `0014_organization.sql` adds the hierarchy and nullable service assignments. Run `pnpm db:migrate` explicitly before using the updated API. API startup never migrates. Composite foreign keys reject cross-workspace ownership; every API read/write rechecks the current session and workspace membership in its transaction.

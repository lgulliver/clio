/** Navigation stays separate so browser behavior can be exercised without leaving tests. */
export function navigateExternal(url: string) {
  window.location.assign(url);
}

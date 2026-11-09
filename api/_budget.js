// Shared hard-ceiling budget check, used by every "price must not exceed X" constraint
// in api/chat.js (both the free-text budget ceiling and the structured known-budget
// range's upper bound). A single implementation so "до X" / "не дороже X" can never
// drift into two different boundary semantics again — price === max passes, price > max
// does not. (Underscore-prefixed so Vercel doesn't expose this as its own endpoint.)
export function exceedsBudget(price, max) {
  return typeof price === 'number' && typeof max === 'number' && price > max;
}

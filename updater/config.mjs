// Docker inspect returns literal environment values. Compose will interpolate
// the generated file again, so escape dollars before writing it. Otherwise an
// encryption key containing $ could change during the first managed restart.
export const composeLiteral = value => value.replaceAll('$', () => '$$')
export function composeEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, composeLiteral(value)]))
}

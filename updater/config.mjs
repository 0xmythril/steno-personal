// Docker inspect returns literal environment values. Compose will interpolate
// the generated file again, so escape dollars before writing it. Otherwise an
// encryption key containing $ could change during the first managed restart.
export const composeLiteral = value => value.replaceAll('$', () => '$$')
export function composeEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, composeLiteral(value)]))
}

// Services that share the app container's network namespace stop networking
// the moment `app` is recreated, so an upgrade must recreate them as well.
// The WeChat sidecar in compose.wechat.yaml is the case this exists for.
export function dependentServices(compose) {
  return Object.entries(compose?.services ?? {})
    .filter(([name, service]) => name !== 'app' && service?.network_mode === 'service:app')
    .map(([name]) => name)
}

// The real `server-only` package throws on import outside a React Server
// Component graph, which would make lib/auth.ts untestable. vitest aliases the
// specifier to this empty module so the guard still protects the Next build
// (where the alias does not apply) and the tests can exercise the code.
export {}

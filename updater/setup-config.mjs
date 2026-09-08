export const SETUP_START = '# BEGIN STENO MANAGED UPGRADES'
export const SETUP_END = '# END STENO MANAGED UPGRADES'

export function managedEnvironment(original, project) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) throw new Error('Invalid Compose project name')
  const starts = original.split(SETUP_START).length - 1
  const ends = original.split(SETUP_END).length - 1
  if (starts !== ends || starts > 1) throw new Error('The managed block in .env is incomplete; repair it before running setup again')
  let prefix = original
  let suffix = ''
  if (starts) {
    const start = original.indexOf(SETUP_START)
    const end = original.indexOf(SETUP_END)
    if (end < start || (start > 0 && original[start - 1] !== '\n')) throw new Error('Invalid managed block in .env')
    prefix = original.slice(0, start)
    suffix = original.slice(end + SETUP_END.length).replace(/^\r?\n/, '')
  }
  prefix += suffix
  if (prefix && !prefix.endsWith('\n')) prefix += '\n'
  return prefix + [
    SETUP_START,
    '# Keeps ordinary docker compose commands on the installed release.',
    'COMPOSE_FILE=.steno-updater/compose.json:.steno-updater/release.json',
    `COMPOSE_PROJECT_NAME=${project}`,
    'COMPOSE_PATH_SEPARATOR=:',
    SETUP_END,
    '',
  ].join('\n')
}

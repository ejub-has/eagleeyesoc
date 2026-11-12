import { NavLink, useMatch } from 'react-router'
import { useNavExpanded } from '../theme'
import { Icon, type IconName } from './icons'

export function NavRail({ slug, isAdmin }: { slug: string; isAdmin: boolean }) {
  const [expanded, toggle] = useNavExpanded()
  const onCase = useMatch('/t/:slug/cases/:number')
  const items: [string, string, IconName][] = [
    ['Cases', '', 'cases'],
    ['Dashboard', 'dashboard', 'dashboard'],
    ['Triage', 'triage', 'triage'],
    ['Workflows', 'workflows', 'workflows'],
    ['Search', 'search', 'search'],
  ]
  if (isAdmin) items.push(['Settings', 'settings', 'settings'])
  const toggleLabel = expanded ? 'Collapse navigation' : 'Expand navigation'

  return (
    <nav className="rail" aria-label="Main" data-expanded={expanded}>
      {items.map(([label, path, icon]) => (
        <NavLink
          key={label}
          to={`/t/${slug}${path && `/${path}`}`}
          end={!path}
          className={({ isActive }) => (isActive || (!path && onCase) ? 'active' : undefined)}
        >
          <Icon name={icon} size={22} />
          <span>{label}</span>
        </NavLink>
      ))}
      <button
        type="button"
        className="rail-toggle"
        aria-expanded={expanded}
        aria-label={toggleLabel}
        title={toggleLabel}
        onClick={toggle}
      >
        <Icon name={expanded ? 'collapse' : 'expand'} size={18} />
        {expanded && <span>Collapse</span>}
      </button>
    </nav>
  )
}

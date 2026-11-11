import { useTheme, type ThemeChoice } from '../theme'
import { Icon } from './icons'

const CHOICES: [ThemeChoice, string][] = [
  ['light', 'Light'],
  ['dark', 'Dark'],
  ['system', 'System'],
]

export function ThemeSwitch() {
  const [theme, setTheme] = useTheme()
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Theme">
      {CHOICES.map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          onClick={() => setTheme(value)}
        >
          <Icon name={value} size={14} />
        </button>
      ))}
    </div>
  )
}

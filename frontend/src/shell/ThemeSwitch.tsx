import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Me } from '../api/client'
import { useTheme, type ThemeChoice } from '../theme'
import { Icon } from './icons'

const CHOICES: [ThemeChoice, string][] = [
  ['light', 'Light'],
  ['dark', 'Dark'],
  ['system', 'System'],
]

export function ThemeSwitch() {
  const queryClient = useQueryClient()
  // Reads the signed-in user from the cache App loads; signed out, the choice stays local.
  const me = useQuery<Me | null>({ queryKey: ['me'], enabled: false }).data
  const store = useMutation({
    mutationFn: async (theme: ThemeChoice) => {
      const { error } = await api.PATCH('/api/me/preferences', { body: { theme } })
      if (error) throw new Error('Could not save the theme')
    },
    onMutate: (theme) =>
      queryClient.setQueryData<Me | null>(['me'], (old) => (old ? { ...old, theme } : old)),
  })
  const [theme, setTheme] = useTheme(me?.theme, me ? (t) => store.mutate(t) : undefined)
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

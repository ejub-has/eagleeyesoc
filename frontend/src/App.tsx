import { useQuery } from '@tanstack/react-query'
import { useEffect, type FormEvent, type ReactNode } from 'react'
import {
  Navigate,
  Outlet,
  Route,
  Routes,
  useNavigate,
  useParams,
} from 'react-router'
import { api, type Me } from './api/client'
import { CasePage } from './cases/CasePage'
import { CasesPage } from './cases/CasesPage'
import { ObservablePage } from './cases/ObservablePage'
import { DashboardPage } from './DashboardPage'
import { SearchPage } from './SearchPage'
import { TriagePage } from './TriagePage'
import { Settings } from './settings/Settings'
import { Logo } from './shell/icons'
import { NavRail } from './shell/NavRail'
import { ThemeSwitch } from './shell/ThemeSwitch'

const TENANT_KEY = 'casemgr.tenant'

async function fetchMe(): Promise<Me | null> {
  const { data, response } = await api.GET('/api/me')
  if (response.status === 401) return null
  if (!data) throw new Error(`Could not load your profile (${response.status})`)
  return data
}

export default function App() {
  const me = useQuery({ queryKey: ['me'], queryFn: fetchMe })

  if (me.isPending) return <Shell />
  if (me.isError) {
    return (
      <Shell>
        <p role="alert">{me.error.message}</p>
      </Shell>
    )
  }
  if (me.data === null) {
    return (
      <Shell>
        <a className="button" href="/api/auth/login">
          Sign in
        </a>
      </Shell>
    )
  }
  return (
    <Routes>
      <Route path="/t/:slug" element={<TenantLayout me={me.data} />}>
        <Route index element={<CasesPage />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="search" element={<SearchPage />} />
        <Route path="triage" element={<TriagePage />} />
        <Route path="cases/:number" element={<CasePage />} />
        <Route path="observables/:observableId" element={<ObservablePage />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Home me={me.data} />} />
    </Routes>
  )
}

function Shell({
  actions,
  rail,
  search,
  children,
}: {
  actions?: ReactNode
  rail?: ReactNode
  search?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="shell">
      <header className="shell-header">
        <span className="brand">
          <Logo />
          Eagle Eye
        </span>
        {search}
        <div className="shell-actions">
          <ThemeSwitch />
          {actions}
        </div>
      </header>
      <div className="shell-body">
        {rail}
        <main className="shell-main">{children}</main>
      </div>
    </div>
  )
}

function storedTenant(): string | null {
  try {
    return localStorage.getItem(TENANT_KEY)
  } catch {
    return null
  }
}

function Home({ me }: { me: Me }) {
  const stored = storedTenant()
  const tenant = me.tenants.find((t) => t.slug === stored) ?? me.tenants[0]
  if (tenant) return <Navigate to={`/t/${tenant.slug}`} replace />
  return (
    <Shell actions={<UserActions me={me} />}>
      <p>You do not have access to any tenant. Ask an administrator to add you to a group.</p>
    </Shell>
  )
}

function UserActions({ me }: { me: Me }) {
  async function signOut() {
    const { data } = await api.POST('/api/auth/logout')
    window.location.assign(data?.logout_url ?? '/')
  }
  return (
    <>
      <span className="user-name">{me.display_name}</span>
      <button type="button" className="ghost" onClick={signOut}>
        Sign out
      </button>
    </>
  )
}

function TenantLayout({ me }: { me: Me }) {
  const { slug } = useParams()
  const navigate = useNavigate()
  const tenant = me.tenants.find((t) => t.slug === slug)

  useEffect(() => {
    if (!tenant) return
    try {
      localStorage.setItem(TENANT_KEY, tenant.slug)
    } catch {
      // Remembering the tenant is a convenience only.
    }
  }, [tenant])

  if (!tenant) return <Navigate to="/" replace />
  const isAdmin = ['config:manage', 'tokens:manage'].some((p) => tenant.permissions.includes(p))

  const tenantSlug = tenant.slug
  function quickSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const q = String(new FormData(event.currentTarget).get('q')).trim()
    if (q) navigate(`/t/${tenantSlug}/search?q=${encodeURIComponent(q)}`)
  }

  const tenantPicker = (
    <label className="tenant-picker">
      Tenant{' '}
      <select value={tenant.slug} onChange={(e) => navigate(`/t/${e.target.value}`)}>
        {me.tenants.map((t) => (
          <option key={t.slug} value={t.slug}>
            {t.name}
          </option>
        ))}
      </select>
    </label>
  )
  const search = (
    <>
      {tenantPicker}
      <form className="quick-search" role="search" onSubmit={quickSearch}>
        <input
          name="q"
          type="search"
          aria-label="Quick search"
          placeholder="Search cases, observables, journal"
        />
      </form>
    </>
  )

  return (
    <Shell
      actions={<UserActions me={me} />}
      rail={<NavRail slug={tenant.slug} isAdmin={isAdmin} />}
      search={search}
    >
      <h1 className="tenant-name">{tenant.name}</h1>
      <Outlet key={tenant.slug} context={tenant} />
    </Shell>
  )
}

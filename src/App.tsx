import { BrowserRouter, Link, Navigate, Route, Routes, useParams } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/auth'
import { LoadingBlock } from './components/ui'
import { SignInPage } from './routes/SignIn'
import { DrawingsPage } from './routes/Drawings'
import { NewDrawingPage } from './routes/NewDrawing'
import { DrawingLayout } from './routes/DrawingLayout'
import { OverviewTab } from './routes/Overview'
import { ImportTab } from './routes/Import'
import { ReviewTab } from './routes/Review'
import { EntrantsTab } from './routes/Entrants'
import { DrawTab } from './routes/Draw'
import { AuditTab } from './routes/Audit'
import { VerifyPage } from './routes/Verify'

/**
 * Gate for the operator console. The public verification page deliberately
 * sits OUTSIDE this — a group member checking the draw must never be asked to
 * sign in, or "anyone can verify it" would not be true.
 */
function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { session, isAdmin, loading, email, signOut } = useAuth()

  if (loading) return <LoadingBlock label="Checking your access…" />
  if (!session) return <SignInPage />

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-lg px-6 py-20 text-center">
        <h1 className="text-lg font-semibold text-ink-900">This account doesn’t have access</h1>
        <p className="mt-2 text-sm text-ink-600">
          You’re signed in as <span className="font-medium">{email}</span>, but that address isn’t on the
          operator allowlist. Add it to the <code className="rounded bg-ink-100 px-1">admin_emails</code> table
          in Supabase, then reload.
        </p>
        <button onClick={() => void signOut()} className="mt-6 text-sm font-medium text-brand-600 hover:underline">
          Sign out
        </button>
      </div>
    )
  }

  return <>{children}</>
}

/** Old bookmarks may point at /drawings/:id; keep them working. */
function LegacyDrawingRedirect() {
  const { id } = useParams()
  return <Navigate to={`/d/${id}`} replace />
}

function NotFound() {
  return (
    <div className="mx-auto max-w-lg px-6 py-20 text-center">
      <h1 className="text-lg font-semibold text-ink-900">Page not found</h1>
      <Link to="/" className="mt-4 inline-block text-sm font-medium text-brand-600 hover:underline">
        Back to drawings
      </Link>
    </div>
  )
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          {/* Public: no auth, by design. */}
          <Route path="/verify/:id" element={<VerifyPage />} />

          <Route
            path="/"
            element={
              <RequireAdmin>
                <DrawingsPage />
              </RequireAdmin>
            }
          />
          <Route
            path="/new"
            element={
              <RequireAdmin>
                <NewDrawingPage />
              </RequireAdmin>
            }
          />
          <Route
            path="/d/:id"
            element={
              <RequireAdmin>
                <DrawingLayout />
              </RequireAdmin>
            }
          >
            <Route index element={<OverviewTab />} />
            <Route path="import" element={<ImportTab />} />
            <Route path="review" element={<ReviewTab />} />
            <Route path="entrants" element={<EntrantsTab />} />
            <Route path="draw" element={<DrawTab />} />
            <Route path="audit" element={<AuditTab />} />
          </Route>

          <Route path="/drawings/:id" element={<LegacyDrawingRedirect />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  )
}

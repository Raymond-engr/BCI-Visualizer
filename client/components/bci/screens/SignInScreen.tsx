"use client"

import { useState, type FormEvent } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useAuth } from "@/contexts/AuthContext"

export function SignInScreen() {
  const router = useRouter()
  const { login } = useAuth()

  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)

    try {
      await login(email, password)
      router.push("/onboarding")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in")
      setPending(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-[400px] px-4 pb-20 pt-6 sm:px-6">
      <Button
        variant="ghost"
        size="sm"
        className="mb-6 -ml-2 text-muted-foreground"
        nativeButton={false}
        render={<Link href="/" />}
      >
        ← Back
      </Button>
      <h2 className="mb-2 font-heading text-3xl font-bold tracking-[-0.02em]">
        Welcome back
      </h2>
      <p className="mb-7 text-sm text-muted-foreground">
        Resume your decoding sessions.
      </p>
      <form className="flex flex-col gap-3.5" onSubmit={onSubmit}>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="signin-email"
            className="font-mono text-[11px] tracking-[0.08em] text-muted-foreground"
          >
            EMAIL
          </label>
          <Input
            id="signin-email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@uniben.edu"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="signin-password"
            className="font-mono text-[11px] tracking-[0.08em] text-muted-foreground"
          >
            PASSWORD
          </label>
          <Input
            id="signin-password"
            type="password"
            required
            autoComplete="current-password"
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive"
          >
            {error}
          </p>
        )}

        <Button
          size="lg"
          type="submit"
          disabled={pending}
          className="mt-1.5 h-auto rounded-xl py-3.5 text-[15px] shadow-[0_8px_24px_rgba(55,226,154,.28)]"
        >
          {pending ? "Signing in…" : "Sign In"}
        </Button>
        <Button
          variant="outline"
          size="lg"
          className="h-auto rounded-xl py-3.5 text-[14px]"
          type="button"
        >
          Continue with SSO
        </Button>
        <p className="mt-1 text-center text-[13px] text-muted-foreground">
          No account?{" "}
          <Link href="/sign-up" className="font-semibold text-primary">
            Create one
          </Link>
        </p>
      </form>
    </div>
  )
}

import Link from "next/link"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export function SignUpScreen() {
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
        Create account
      </h2>
      <p className="mb-7 text-sm text-muted-foreground">
        Start decoding in under a minute.
      </p>
      <form className="flex flex-col gap-3.5">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="signup-name"
            className="font-mono text-[11px] tracking-[0.08em] text-muted-foreground"
          >
            FULL NAME
          </label>
          <Input id="signup-name" type="text" placeholder="Ada Lovelace" />
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="signup-email"
            className="font-mono text-[11px] tracking-[0.08em] text-muted-foreground"
          >
            EMAIL
          </label>
          <Input id="signup-email" type="email" placeholder="you@uniben.edu" />
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="signup-password"
            className="font-mono text-[11px] tracking-[0.08em] text-muted-foreground"
          >
            PASSWORD
          </label>
          <Input id="signup-password" type="password" placeholder="8+ characters" />
        </div>
        <Button
          size="lg"
          className="mt-1.5 h-auto rounded-xl py-3.5 text-[15px] shadow-[0_8px_24px_rgba(55,226,154,.28)]"
          nativeButton={false}
          render={<Link href="/onboarding" />}
        >
          Create Account
        </Button>
        <p className="mt-1 text-center text-[13px] text-muted-foreground">
          Have an account?{" "}
          <Link href="/sign-in" className="font-semibold text-primary">
            Sign in
          </Link>
        </p>
      </form>
    </div>
  )
}

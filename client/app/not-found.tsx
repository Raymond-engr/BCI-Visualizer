import Link from "next/link"

import { Button } from "@/components/ui/button"

export const metadata = {
  title: "Signal lost · BCI Visualizer",
}

export default function NotFound() {
  return (
    <div className="mx-auto flex w-full max-w-[460px] flex-col items-center px-4 pb-24 pt-16 text-center sm:px-6">
      <p className="mb-5 font-mono text-[11px] tracking-[0.18em] text-muted-foreground">
        ERROR 404 · SIGNAL LOST
      </p>

      <div className="relative mb-2">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center font-heading text-[112px] font-extrabold leading-none text-primary/20 blur-2xl"
        >
          404
        </span>
        <span className="relative font-heading text-[112px] font-extrabold leading-none tracking-[-0.03em] text-foreground">
          404
        </span>
      </div>

      <h1 className="mb-3 font-heading text-2xl font-bold tracking-[-0.02em]">
        No stream on this channel.
      </h1>
      <p className="mb-8 max-w-[360px] text-sm leading-relaxed text-muted-foreground">
        The page you reached isn&apos;t decoding to anything — the link may be
        stale or the route may have moved. Let&apos;s get you back to a live
        signal.
      </p>

      <div className="flex w-full max-w-[300px] flex-col gap-3">
        <Button
          size="lg"
          nativeButton={false}
          render={<Link href="/" />}
          className="h-auto rounded-xl py-3.5 text-[15px] shadow-[0_8px_24px_rgba(55,226,154,.28)]"
        >
          Back to home
        </Button>
        <Button
          variant="outline"
          size="lg"
          nativeButton={false}
          render={<Link href="/dashboard" />}
          className="h-auto rounded-xl py-3.5 text-[14px]"
        >
          Go to dashboard
        </Button>
      </div>
    </div>
  )
}

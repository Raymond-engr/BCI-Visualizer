import Link from "next/link"

export function TopNav() {
  return (
    <header className="fixed inset-x-0 top-0 z-40 flex items-center justify-between gap-4 bg-gradient-to-b from-background/85 to-transparent px-4 py-3.5 backdrop-blur-sm sm:px-6">
      <Link href="/" className="flex items-center gap-2.5">
        <span className="flex size-[30px] items-center justify-center rounded-[9px] bg-gradient-to-br from-primary to-[#14A06B] shadow-[0_0_18px_rgba(55,226,154,0.45)]">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#06110C"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M2 12h3l2-6 3 12 3-9 2 3h7" />
          </svg>
        </span>
        <span className="font-heading text-base font-bold tracking-tight text-foreground">
          BCI Visualizer
        </span>
      </Link>
      <span className="font-mono text-[11px] tracking-[0.08em] text-muted-foreground">
        v1.0 · UNIBEN
      </span>
    </header>
  )
}

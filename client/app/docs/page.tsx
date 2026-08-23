import Link from "next/link"

const NAV = [
  { href: "#overview", label: "Overview" },
  { href: "#concepts", label: "Key Terms" },
  { href: "#getting-started", label: "Getting Started" },
  { href: "#modes", label: "Choosing a Source" },
  { href: "#dashboard", label: "The Dashboard" },
  { href: "#controls", label: "Live Controls" },
  { href: "#results", label: "Results & Export" },
  { href: "#faq", label: "FAQ" },
]

const GLOSSARY = [
  {
    term: "EEG (Electroencephalography)",
    def: "Electrical activity from the brain, picked up by electrodes on the scalp. It's the raw signal everything else here is built from.",
  },
  {
    term: "Motor Imagery",
    def: "The brain activity produced when you imagine moving a body part without actually moving it — e.g. imagining squeezing your left hand. It produces a distinct, detectable pattern over the motor cortex.",
  },
  {
    term: "Epoch",
    def: "A short window of signal (4 seconds here) that gets analysed as one unit. A new classification is produced once per second, using the most recent epoch.",
  },
  {
    term: "Classification",
    def: "The system's best guess at what you were imagining during the last epoch: left hand, right hand, or feet.",
  },
  {
    term: "Confidence",
    def: "How sure the model is about that guess, from 0–100%. Low confidence doesn't mean an error — it means the signal was ambiguous for that window.",
  },
  {
    term: "Bandpass / Notch filter",
    def: "Signal cleanup settings. The bandpass filter keeps only the frequency range the model was trained on; the notch filter removes mains electrical hum.",
  },
]

const MODES = [
  {
    title: "Run Simulation",
    badge: "No hardware needed",
    body:
      'Streams a real, pre-recorded EEG session back to you as if it were happening live. This is the fastest way to see the whole system work end-to-end, and it\'s what the "Launch Live Demo" button on the home page uses.',
    steps: [
      "Click Run Simulation from the home page.",
      "The dashboard opens immediately and data starts streaming.",
      "Watch the waveform, spectrum, and classification update in real time.",
    ],
  },
  {
    title: "Analyse Dataset",
    badge: "Upload your own",
    body:
      "Upload a recording you already have (.gdf or .csv) and replay it through the same pipeline, faster than real time by default.",
    steps: [
      "Click Analyse Dataset from the home page.",
      "Choose your file — a .gdf or .csv EEG recording.",
      "Once it uploads, start the session from your dataset list.",
      "It plays back at 8x speed by default, so a long recording finishes quickly.",
    ],
  },
  {
    title: "Connect Hardware",
    badge: "Live headset",
    body:
      "Streams from a real EEG headset (e.g. OpenBCI or a BLE device) in real time. This requires a small local bridge program running on your machine that talks to the headset directly and forwards data in — browsers can't access serial or Bluetooth hardware on their own.",
    steps: [
      "Have your headset's bridge process running and note its WebSocket address.",
      "Click Connect Hardware from the home page and enter that address.",
      "Put the headset on, get good electrode contact, and start the session.",
    ],
  },
]

const DASHBOARD_ITEMS = [
  {
    title: "Waveform",
    body:
      'The raw, filtered EEG signal, scrolling continuously. This updates about 25 times a second — it\'s the most "live" thing on screen.',
  },
  {
    title: "Power Spectrum",
    body:
      "Shows how much signal energy is present at each frequency. Motor imagery shows up as dips and peaks in specific bands, which is part of what the classifier looks at.",
  },
  {
    title: "Scalp Topography",
    body:
      "A map of signal strength across electrode positions. Left-hand imagery tends to light up the right side of the motor cortex and vice versa — this panel makes that visible.",
  },
  {
    title: "Classification badge",
    body:
      "The current best guess (left hand / right hand / feet) plus a confidence percentage. It only changes once per second, on epoch boundaries — the waveform keeps moving underneath it in the meantime, which is expected, not a freeze.",
  },
  {
    title: "3D visual",
    body:
      "A visual representation of the stream that shifts and colors itself based on the live classification and confidence — a glanceable read of what's happening, not a diagnostic tool on its own.",
  },
]

const FAQ = [
  {
    q: "Why is my accuracy blank after a hardware session?",
    a: "A live headset has no way to record what you actually intended to imagine at each moment, so there's no ground truth to score predictions against. Accuracy is only ever available for Simulation and Dataset sessions, where the original recording already has that information attached.",
  },
  {
    q: "Why does the classification only update once a second?",
    a: "Each classification is produced from a 4-second window of signal, and a new one closes roughly every second. Updating any faster wouldn't reflect a genuinely new window — it would just repeat stale analysis.",
  },
  {
    q: 'What counts as a "good" confidence score?',
    a: "There's no fixed threshold — it varies by person and by session. What matters more is consistency: if confidence is reliably higher for one class than the others across a session, the signal is being read cleanly.",
  },
  {
    q: "My dataset upload failed — what formats are supported?",
    a: "Only .gdf and .csv recordings are accepted. If a .csv fails, the most common cause is an inconsistent number of columns per row.",
  },
  {
    q: "Can I change filter settings mid-session?",
    a: "Yes — the bandpass and notch controls apply to a running stream immediately, without restarting the session. If you enter an unsupported band, the change is rejected and your previous setting stays in effect, so a bad value never breaks the stream.",
  },
]

export default function DocsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 pb-24 pt-4 sm:px-6">
      <Link
        href="/"
        className="mb-6 inline-block text-sm text-muted-foreground hover:text-foreground"
      >
        ← Back
      </Link>

      <h1 className="mb-3 font-heading text-4xl font-bold tracking-[-0.02em]">
        Docs
      </h1>
      <p className="mb-6 max-w-xl text-base leading-relaxed text-muted-foreground">
        Everything you need to run a session, read the dashboard, and make
        sense of your results — no EEG background required.
      </p>

      <nav className="mb-12 flex flex-wrap gap-2">
        {NAV.map((n) => (
          <a
            key={n.href}
            href={n.href}
            className="rounded-full border border-border bg-secondary/45 px-3 py-1.5 font-mono text-[11px] tracking-[0.04em] text-muted-foreground transition-colors hover:text-foreground"
          >
            {n.label}
          </a>
        ))}
      </nav>

      <section id="overview" className="mb-14 scroll-mt-24">
        <h2 className="mb-3 font-heading text-2xl font-semibold">Overview</h2>
        <p className="text-[15px] leading-relaxed text-muted-foreground">
          BCI Visualizer reads brain signal (EEG) and figures out which of
          three things you're imagining doing — moving your left hand, your
          right hand, or your feet — without you actually moving. It shows
          that decoding happening live: the raw signal, its frequency
          content, a map of where on the scalp the activity is strongest, and
          the system's running guess with a confidence score. You can feed it
          a live headset, a pre-recorded file, or just watch a bundled demo
          stream — all three go through the exact same pipeline.
        </p>
      </section>

      <section id="concepts" className="mb-14 scroll-mt-24">
        <h2 className="mb-4 font-heading text-2xl font-semibold">
          Key Terms
        </h2>
        <div className="flex flex-col gap-3">
          {GLOSSARY.map((g) => (
            <div
              key={g.term}
              className="rounded-2xl border border-border bg-secondary/45 p-4 backdrop-blur-md"
            >
              <div className="mb-1 font-heading text-[15px] font-semibold">
                {g.term}
              </div>
              <div className="text-[13.5px] leading-relaxed text-muted-foreground">
                {g.def}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section id="getting-started" className="mb-14 scroll-mt-24">
        <h2 className="mb-4 font-heading text-2xl font-semibold">
          Getting Started
        </h2>
        <ol className="flex flex-col gap-3">
          {[
            "Create an account, or sign in if you already have one.",
            "From the home page, pick how you want to get signal in: a live demo, your own uploaded recording, or a real headset.",
            "The dashboard opens and starts streaming as soon as the session starts.",
          ].map((step, i) => (
            <li
              key={step}
              className="flex gap-3 rounded-2xl border border-border bg-secondary/45 p-4 backdrop-blur-md"
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/16 font-mono text-[12px] font-bold text-primary">
                {i + 1}
              </span>
              <span className="text-[14px] leading-relaxed text-muted-foreground">
                {step}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section id="modes" className="mb-14 scroll-mt-24">
        <h2 className="mb-4 font-heading text-2xl font-semibold">
          Choosing a Source
        </h2>
        <div className="flex flex-col gap-4">
          {MODES.map((m) => (
            <div
              key={m.title}
              className="rounded-2xl border border-border bg-secondary/45 p-5 backdrop-blur-md"
            >
              <div className="mb-2 flex items-center gap-2">
                <h3 className="font-heading text-lg font-semibold">
                  {m.title}
                </h3>
                <span className="rounded-md bg-primary/14 px-2 py-0.5 font-mono text-[9px] tracking-[0.1em] text-primary">
                  {m.badge}
                </span>
              </div>
              <p className="mb-3 text-[14px] leading-relaxed text-muted-foreground">
                {m.body}
              </p>
              <ul className="ml-4 list-disc space-y-1 text-[13.5px] leading-relaxed text-muted-foreground">
                {m.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section id="dashboard" className="mb-14 scroll-mt-24">
        <h2 className="mb-4 font-heading text-2xl font-semibold">
          The Dashboard
        </h2>
        <p className="mb-4 text-[14px] leading-relaxed text-muted-foreground">
          Once a session starts, everything updates live. Here's what each
          part is showing you:
        </p>
        <div className="flex flex-col gap-3">
          {DASHBOARD_ITEMS.map((d) => (
            <div
              key={d.title}
              className="rounded-2xl border border-border bg-secondary/45 p-4 backdrop-blur-md"
            >
              <div className="mb-1 font-heading text-[15px] font-semibold">
                {d.title}
              </div>
              <div className="text-[13.5px] leading-relaxed text-muted-foreground">
                {d.body}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section id="controls" className="mb-14 scroll-mt-24">
        <h2 className="mb-3 font-heading text-2xl font-semibold">
          Live Controls
        </h2>
        <p className="text-[14px] leading-relaxed text-muted-foreground">
          The bandpass range and notch filter toggle on the dashboard apply
          to the stream while it's running — you don't need to stop and
          restart a session to change them. If a setting isn't supported, it
          gets rejected and your stream keeps running on whatever was working
          before, so an experiment with the controls can't break your
          session.
        </p>
      </section>

      <section id="results" className="mb-14 scroll-mt-24">
        <h2 className="mb-3 font-heading text-2xl font-semibold">
          Results & Export
        </h2>
        <p className="text-[14px] leading-relaxed text-muted-foreground">
          When a session ends, you get a summary: overall accuracy, average
          confidence, and a breakdown by class. You can also export the full
          epoch-by-epoch log as a CSV for your own analysis. Accuracy is only
          shown for Simulation and Dataset sessions — see the FAQ below for
          why hardware sessions don't have it.
        </p>
      </section>

      <section id="faq" className="mb-14 scroll-mt-24">
        <h2 className="mb-4 font-heading text-2xl font-semibold">FAQ</h2>
        <div className="flex flex-col gap-2">
          {FAQ.map((f) => (
            <details
              key={f.q}
              className="group rounded-2xl border border-border bg-secondary/45 p-4 backdrop-blur-md"
            >
              <summary className="cursor-pointer font-heading text-[14.5px] font-semibold marker:content-none">
                {f.q}
              </summary>
              <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
                {f.a}
              </p>
            </details>
          ))}
        </div>
      </section>

      <p className="text-[13px] text-muted-foreground">
        Building on top of this instead of just using it? Full REST/WebSocket
        reference:{" "}
        <Link
          href="/api-docs"
          className="font-semibold text-primary"
          target="_blank"
          rel="noreferrer"
        >
          Swagger UI
        </Link>{" "}
        · Source:{" "}
        <a
          href="https://github.com/Raymond-engr/BCI-Visualizer"
          className="font-semibold text-primary"
          target="_blank"
          rel="noreferrer"
        >
          GitHub
        </a>
      </p>
    </div>
  )
}
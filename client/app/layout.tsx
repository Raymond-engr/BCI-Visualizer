import type { Metadata } from "next";
import { Bricolage_Grotesque, Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

import { BackgroundField } from "@/components/bci/BackgroundField";
import { TopNav } from "@/components/bci/TopNav";
import { AuthProvider } from "@/contexts/AuthContext";
import { BciEngineProvider } from "@/contexts/BciEngineContext";
import { BciSessionProvider } from "@/contexts/BciSessionContext";

const hankenGrotesk = Hanken_Grotesk({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const bricolageGrotesque = Bricolage_Grotesque({
  variable: "--font-heading",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
});

const jetBrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "BCI Visualizer",
  description:
    "Stream EEG brain signals, classify Motor Imagery tasks in real time, and watch thought render as living 3D — built for UNIBEN.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`dark ${hankenGrotesk.variable} ${bricolageGrotesque.variable} ${jetBrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground relative">
        <AuthProvider>
          <BciEngineProvider>
            <BciSessionProvider>
              <BackgroundField />
              <TopNav />
              <main className="relative z-10 flex-1 pt-[78px]">{children}</main>
            </BciSessionProvider>
          </BciEngineProvider>
        </AuthProvider>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";

export const metadata: Metadata = {
  title: "Robinhood Agent",
  robots: "noindex",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style>{`
          *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
          body { background: #0a0a0a; color: #e5e5e5; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-size: 14px; line-height: 1.5; }
          a { color: inherit; text-decoration: none; }
        `}</style>
      </head>
      <body>{children}<Analytics /></body>
    </html>
  );
}
